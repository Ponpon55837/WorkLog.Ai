import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAgentSetupPlan, applyAgentSetupTransaction, createAgentSetupPlan } from "@work-intelligence/agent-setup";
import { createFixture, removeFixtures } from "./fixture.js";

/**
 * Runs inside every `lstatSync`, which `readCurrent` calls first. The re-check right before a rename is the lstat that
 * follows the temporary file being written, so a test counts the lstats of one path to edit it inside that window.
 */
const hook = vi.hoisted(() => ({ onLstat: undefined as undefined | ((path: string) => void) }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      hook.onLstat?.(String(args[0]));
      return actual.lstatSync(...args);
    },
  };
});

/** Calls `edit` instead of the real lstat on the `occurrence`th (1-based) lstat of `path`. */
function editOnLstat(path: string, occurrence: number, edit: () => void): void {
  let seen = 0;
  hook.onLstat = (current) => {
    if (current === path && ++seen === occurrence) edit();
  };
}

afterEach(() => {
  hook.onLstat = undefined;
  removeFixtures();
});

describe("re-check right before the rename", () => {
  it("never replaces a file edited after the temporary file was written, and compensates earlier items", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const target = plan.mutations.findIndex((mutation) => mutation.path === fixture.paths.claudeJson);
    expect(target).toBeGreaterThan(0);
    const edited = Buffer.from('{ "edited": "in the window" }\n');
    // lstat 1 is the apply's pre-check of this item; lstat 2 is the re-check right before the rename.
    editOnLstat(fixture.paths.claudeJson, 2, () => writeFileSync(fixture.paths.claudeJson, edited));

    const result = applyAgentSetupTransaction(plan, { journalPath: fixture.paths.journal });

    expect(result.outcome).toBe("rolled-back");
    expect(result.items[target]).toMatchObject({ status: "externally-modified", code: "externally-modified" });
    expect(readFileSync(fixture.paths.claudeJson)).toEqual(edited);
    expect(result.items.slice(0, target).every((item) => item.compensation === "restored")).toBe(true);
  });

  it("reports the CLI apply as changed-after-preview when the file changes inside the window", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    // lstat 1 is the CLI pre-check, 2 the transaction's per-item check, 3 the re-check right before the rename.
    editOnLstat(fixture.paths.claudeJson, 3, () => writeFileSync(fixture.paths.claudeJson, "{}\n"));

    const result = applyAgentSetupPlan(plan);

    expect(result.applied).toBe(false);
    expect(result.conflicts.join(" ")).toContain("在預覽後已變更");
    expect(existsSync(fixture.paths.manifest)).toBe(false);
  });

  it("leaves a file edited inside the compensation window for manual repair instead of overwriting it", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const edited = Buffer.from("edited during compensation\n");
    const last = plan.mutations.length - 1;

    const result = applyAgentSetupTransaction(plan, {
      journalPath: fixture.paths.journal,
      beforeWrite: (_mutation, index) => {
        if (index === last) {
          // Compensation reads the item (lstat 1), then re-checks it right before restoring (lstat 2).
          editOnLstat(fixture.paths.claudeJson, 2, () => writeFileSync(fixture.paths.claudeJson, edited));
          throw new Error("injected");
        }
      },
    });

    expect(result.outcome).toBe("needs-manual-repair");
    expect(result.items.some((item) => item.compensation === "manual-repair")).toBe(true);
    expect(readFileSync(fixture.paths.claudeJson)).toEqual(edited);
  });
});
