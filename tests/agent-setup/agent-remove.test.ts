import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAgentSetupTransaction,
  createAgentSetupPlan,
  readAgentSetupJournal,
} from "@work-intelligence/agent-setup";
import { commitAgentPlan, filesLeftByTransaction } from "../../apps/desktop/src/main/agents.js";
import { createFixture, removeFixtures } from "./fixture.js";

afterEach(removeFixtures);

describe("what an unfinished Agent apply leaves behind (L-20)", () => {
  it("lists the files of a transaction compensation had to leave, and only those", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const written = new Set<string>();
    const applied = applyAgentSetupTransaction(plan, {
      journalPath: fixture.paths.journal,
      afterWrite: (mutation) => {
        written.add(mutation.path);
        // An Agent rewrites the Claude config right after we wrote it, then the next write fails.
        if (mutation.path === fixture.paths.claudeJson) {
          // Our own entry is changed, so it cannot be taken out without guessing.
          const root = JSON.parse(readFileSync(mutation.path, "utf8")) as {
            mcpServers: Record<string, { args: string[] }>;
          };
          root.mcpServers["work-intelligence"]?.args.push("--changed");
          writeFileSync(mutation.path, JSON.stringify(root, null, 2));
        }
      },
      beforeWrite: (mutation) => {
        if (mutation.path === fixture.paths.manifest) throw new Error("synthetic write failure");
      },
    });

    expect(applied.outcome).toBe("needs-manual-repair");
    const left = filesLeftByTransaction(applied);
    expect(left).toContain(fixture.paths.claudeJson);
    expect(left).not.toContain(fixture.paths.manifest);
    for (const path of left) expect(written.has(path) || path === fixture.paths.manifest).toBe(true);
    expect(left.length).toBeLessThan(plan.mutations.length);
  });
});

describe("removing Agent setup goes through the same plan, apply and undo path as installing", () => {
  it("previews only what setup wrote, applies it through the single commit function and can be undone", () => {
    const fixture = createFixture();
    expect(commitAgentPlan(createAgentSetupPlan(fixture.options), fixture.paths.journal).outcome).toBe("committed");
    const installed = readFileSync(fixture.paths.claudeJson, "utf8");
    expect(installed).toContain("work-intelligence");

    const removal = createAgentSetupPlan(fixture.options, "uninstall");
    expect(removal.mode).toBe("uninstall");
    expect(removal.conflicts).toEqual([]);
    expect(removal.mutations.length).toBeGreaterThan(0);

    expect(commitAgentPlan(removal, fixture.paths.journal).outcome).toBe("committed");
    const claude = JSON.parse(readFileSync(fixture.paths.claudeJson, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(claude.mcpServers)).toEqual(["existing"]);
    const read = readAgentSetupJournal(fixture.paths.journal);
    expect(read.status === "found" && read.journal.state).toBe("committed");
  });
});
