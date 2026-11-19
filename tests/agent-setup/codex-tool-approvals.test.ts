import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAgentSetupTransaction,
  createAgentSetupPlan,
  inspectAgentRegistrations,
  undoAgentSetupOperation,
} from "@work-intelligence/agent-setup";
import { codexWorkIntelligenceServer } from "../../packages/agent-setup/src/toml.js";
import { createFixture, removeFixtures, type SetupFixture } from "./fixture.js";

afterEach(removeFixtures);

const PREFERENCES = ["# prefs", 'model = "fixture-model"', ""];
const APPROVAL = [
  "[mcp_servers.work-intelligence.tools.record_work]",
  'approval_mode = "approve"',
  "",
  "[mcp_servers.work-intelligence.tools.search_work]",
  'approval_mode = "prompt"',
  "",
];

function commit(fixture: SetupFixture, mode: "install" | "uninstall" = "install"): void {
  const plan = createAgentSetupPlan(fixture.options, mode);
  expect(plan.conflicts).toEqual([]);
  expect(applyAgentSetupTransaction(plan, { journalPath: fixture.paths.journal }).outcome).toBe("committed");
}

const config = (fixture: SetupFixture): string => readFileSync(fixture.paths.codexConfig, "utf8");

function serverOf(text: string): Record<string, unknown> {
  return (codexWorkIntelligenceServer(text) ?? {}) as Record<string, unknown>;
}

describe.each([
  ["LF", "\n"],
  ["CRLF (Windows)", "\r\n"],
])("Codex tool approvals around removing and setting up again, %s", (_name, newline) => {
  const lines = (parts: string[]): string => parts.join(newline);

  function installedWithApprovals(where: "after" | "inside"): { fixture: SetupFixture; withApprovals: string } {
    const fixture = createFixture();
    writeFileSync(fixture.paths.codexConfig, lines(PREFERENCES));
    commit(fixture);
    const installed = config(fixture);
    expect(installed).toContain("[mcp_servers.work-intelligence]");
    // Codex appends its approvals after the last table, which is inside our block when the block ends the file.
    const marker = installed.lastIndexOf("# <<<");
    const withApprovals =
      where === "after" || marker < 0
        ? installed + lines(APPROVAL)
        : installed.slice(0, marker) + lines(APPROVAL) + installed.slice(marker);
    writeFileSync(fixture.paths.codexConfig, withApprovals);
    return { fixture, withApprovals };
  }

  it.each(["after", "inside"] as const)(
    "removes the block and the approvals that follow it, in one transaction an undo restores (%s)",
    (where) => {
      const { fixture, withApprovals } = installedWithApprovals(where);

      commit(fixture, "uninstall");

      const removed = config(fixture);
      expect(removed).not.toContain("work-intelligence");
      expect(removed).toBe(lines(PREFERENCES));
      expect(
        undoAgentSetupOperation(fixture.paths.journal, { homeDirectory: fixture.options.homeDirectory }).status,
      ).toBe("undone");
      expect(config(fixture)).toBe(withApprovals);
    },
  );

  it("sets up again after a removal that left only the approvals, keeps them and reports no conflict", () => {
    const fixture = createFixture();
    // What 1.6.56 left behind: the block gone, Codex's approval tables still in the file.
    writeFileSync(fixture.paths.codexConfig, lines([...PREFERENCES, ...APPROVAL]));
    expect(inspectAgentRegistrations(fixture.options).registrations.filter((item) => item.agent === "codex")).toEqual(
      [],
    );

    const plan = createAgentSetupPlan(fixture.options);
    expect(plan.conflicts).toEqual([]);
    expect(applyAgentSetupTransaction(plan, { journalPath: fixture.paths.journal }).outcome).toBe("committed");

    const text = config(fixture);
    const server = serverOf(text);
    expect(server.command).toBe("node");
    expect(Object.keys(server.tools as object)).toEqual(["record_work", "search_work"]);
    expect(server.tools).toEqual({
      record_work: { approval_mode: "approve" },
      search_work: { approval_mode: "prompt" },
    });
    expect(text.indexOf("[mcp_servers.work-intelligence]")).toBeLessThan(
      text.indexOf("[mcp_servers.work-intelligence.tools.record_work]"),
    );
    expect(text.startsWith(lines(PREFERENCES))).toBe(true);
    // Every line break of the file is the file's own.
    expect(text.replaceAll(newline, "").includes(newline === "\r\n" ? "\r" : "\n")).toBe(false);
    expect(
      inspectAgentRegistrations(fixture.options)
        .registrations.filter((item) => item.agent === "codex" && item.kind === "mcp")
        .map((item) => item.source),
    ).toEqual(["manual"]);

    // Setting up once more changes nothing.
    const again = createAgentSetupPlan(fixture.options);
    expect(again.conflicts).toEqual([]);
    expect(again.mutations.some((mutation) => mutation.path === fixture.paths.codexConfig)).toBe(false);
  });

  it("goes through the whole cycle: set up, Codex approves, remove, set up again", () => {
    const { fixture } = installedWithApprovals("after");
    commit(fixture, "uninstall");
    expect(config(fixture)).not.toContain("work-intelligence");

    commit(fixture);

    const text = config(fixture);
    expect(serverOf(text).command).toBe("node");
    expect(text.startsWith(lines(PREFERENCES))).toBe(true);
    expect(createAgentSetupPlan(fixture.options).conflicts).toEqual([]);
  });

  it("still refuses a registration that is not a command, with or without approvals", () => {
    const fixture = createFixture();
    const text = lines([
      ...PREFERENCES,
      "[mcp_servers.work-intelligence]",
      'url = "https://example.invalid/mcp"',
      "",
      ...APPROVAL,
    ]);
    writeFileSync(fixture.paths.codexConfig, text);

    const plan = createAgentSetupPlan(fixture.options);

    expect(plan.conflicts.length).toBeGreaterThan(0);
    expect(plan.mutations.some((mutation) => mutation.path === fixture.paths.codexConfig)).toBe(false);
    expect(config(fixture)).toBe(text);
  });
});
