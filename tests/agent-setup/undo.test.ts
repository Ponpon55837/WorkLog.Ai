import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAgentSetupTransaction,
  commandForAgentHook,
  createAgentSetupPlan,
  readAgentSetupJournal,
  recoverAgentSetupJournal,
  undoAgentSetupOperation,
  type AgentSetupPlan,
  type AgentSetupPlanOptions,
  type AgentSetupUndoResult,
} from "@work-intelligence/agent-setup";
import { writeAgentSetupJournal } from "../../packages/agent-setup/src/journal.js";
import { createFixture, removeFixtures, writeJson, type SetupFixture } from "./fixture.js";

const SHIM = "/opt/Work Intelligence/bin/work-intelligence-launcher";
const WINDOWS_SHIM = "C:\\Users\\測試 使用者\\AppData\\Local\\Work Intelligence\\bin\\work-intelligence-launcher.cmd";
const PLATFORM: NodeJS.Platform = process.platform === "win32" ? "win32" : "linux";
const HOST_SHIM = PLATFORM === "win32" ? WINDOWS_SHIM : SHIM;

function userFilePaths(fixture: SetupFixture): string[] {
  const { codexConfig, codexHooks, claudeJson, claudeSettings, manifest, codexSkill } = fixture.paths;
  return [codexConfig, codexHooks, claudeJson, claudeSettings, manifest, codexSkill];
}

function snapshot(fixture: SetupFixture): Map<string, Buffer | null> {
  return new Map(userFilePaths(fixture).map((path) => [path, existsSync(path) ? readFileSync(path) : null]));
}

function expectSnapshot(expected: Map<string, Buffer | null>): void {
  for (const [path, bytes] of expected) {
    if (bytes === null) expect(existsSync(path), path).toBe(false);
    else expect(readFileSync(path), path).toEqual(bytes);
  }
}

function undoAt(fixture: SetupFixture, options?: Parameters<typeof undoAgentSetupOperation>[2]): AgentSetupUndoResult {
  return undoAgentSetupOperation(fixture.paths.journal, { homeDirectory: fixture.options.homeDirectory }, options);
}

/** Changes our own Claude MCP entry (not just the file around it), so no safe entry-level removal exists. */
function editOurClaudeEntry(fixture: SetupFixture): void {
  const root = JSON.parse(readFileSync(fixture.paths.claudeJson, "utf8")) as {
    mcpServers: Record<string, { args: string[] }>;
  };
  const ours = root.mcpServers["work-intelligence"];
  if (!ours) throw new Error("missing entry");
  ours.args = [...ours.args, "--changed-by-someone-else"];
  writeFileSync(fixture.paths.claudeJson, JSON.stringify(root, null, 2) + "\n");
}

function commit(fixture: SetupFixture, plan: AgentSetupPlan = createAgentSetupPlan(fixture.options)): AgentSetupPlan {
  expect(applyAgentSetupTransaction(plan, { journalPath: fixture.paths.journal }).outcome).toBe("committed");
  return plan;
}

function backupsOf(plan: AgentSetupPlan): string[] {
  return plan.mutations.flatMap((mutation) => (mutation.backupPath ? [mutation.backupPath] : []));
}

function journalState(fixture: SetupFixture): string | undefined {
  const read = readAgentSetupJournal(fixture.paths.journal);
  return read.status === "found" ? read.journal.state : read.status;
}

function launcherOptions(fixture: SetupFixture, roots: string[]): AgentSetupPlanOptions {
  return {
    ...fixture.options,
    target: {
      kind: "launcher",
      shimPath: fixture.options.platform === "win32" ? WINDOWS_SHIM : SHIM,
      skillSourcePath: fixture.paths.skillSource,
    },
    adopt: { repositoryRoots: roots },
  };
}

afterEach(removeFixtures);

describe("undoAgentSetupOperation", () => {
  it("restores every file to what it was before the last committed operation and then cleans up", () => {
    const fixture = createFixture();
    const before = snapshot(fixture);
    const plan = commit(fixture);
    expect(backupsOf(plan).length).toBeGreaterThan(0);
    expect(backupsOf(plan).every((path) => existsSync(path))).toBe(true);

    const result = undoAt(fixture);

    expect(result.status).toBe("undone");
    expect(result.items.length).toBe(plan.mutations.length);
    expect(result.items.every((item) => item.compensation === "restored")).toBe(true);
    expectSnapshot(before);
    expect(backupsOf(plan).some((path) => existsSync(path))).toBe(false);
    expect(journalState(fixture)).toBe("compensated");
  });

  it("is idempotent: a second undo reports nothing to undo and touches nothing", () => {
    const fixture = createFixture();
    commit(fixture);
    expect(undoAt(fixture).status).toBe("undone");
    const after = snapshot(fixture);

    expect(undoAt(fixture)).toMatchObject({ status: "nothing-to-undo" });
    expectSnapshot(after);
  });

  it("reports nothing to undo without a journal and refuses an unfinished or unreadable one", () => {
    const fixture = createFixture();
    expect(undoAt(fixture)).toEqual({ status: "nothing-to-undo", items: [] });

    writeFileSync(fixture.paths.journal, "not a journal");
    expect(undoAt(fixture)).toMatchObject({ status: "refused", code: "journal-unreadable" });
    expect(readFileSync(fixture.paths.journal, "utf8")).toBe("not a journal");
    writeFileSync(fixture.paths.journal, "{}");

    const plan = createAgentSetupPlan(fixture.options);
    const journal = {
      version: 1 as const,
      operationId: "pending-operation",
      state: "pending" as const,
      startedAt: "2026-09-28T12:34:56.000Z",
      items: plan.mutations.map((mutation) => ({
        path: mutation.path,
        label: mutation.label,
        mode: mutation.mode,
        beforeFingerprint: mutation.beforeFingerprint,
        afterFingerprint: mutation.afterFingerprint,
        state: "planned" as const,
      })),
      createdDirectories: [],
    };
    writeAgentSetupJournal(fixture.paths.journal, journal);
    expect(undoAt(fixture)).toMatchObject({ status: "refused", code: "unfinished-journal" });
  });

  it("refuses a committed journal that names files setup does not own", () => {
    const fixture = createFixture();
    commit(fixture);
    const read = readAgentSetupJournal(fixture.paths.journal);
    if (read.status !== "found") throw new Error("missing journal");
    const victim = `${fixture.temporaryRoot}/victim.txt`;
    writeFileSync(victim, "keep me");
    const first = read.journal.items[0];
    if (!first) throw new Error("no items");
    first.path = victim;
    writeAgentSetupJournal(fixture.paths.journal, read.journal);

    expect(undoAt(fixture)).toMatchObject({ status: "refused", code: "journal-paths-invalid" });
    expect(readFileSync(victim, "utf8")).toBe("keep me");
  });

  it("stops at the first item changed after the operation, reports its path and leaves it and the earlier items alone", () => {
    const fixture = createFixture();
    const plan = commit(fixture);
    // Our own entry was changed, so it cannot be taken out without guessing; a harmless rewrite would be handled by
    // the entry-level fallback instead (see "after an Agent rewrote its config" below).
    editOurClaudeEntry(fixture);
    const edited = readFileSync(fixture.paths.claudeJson);
    const claudeIndex = plan.mutations.findIndex((mutation) => mutation.path === fixture.paths.claudeJson);
    const installedSkill = readFileSync(fixture.paths.codexSkill);

    const result = undoAt(fixture);

    expect(result.status).toBe("needs-manual-repair");
    expect(result.manualRepairPath).toBe(fixture.paths.claudeJson);
    expect(result.items[claudeIndex]?.compensation).toBe("manual-repair");
    expect(result.items.slice(0, claudeIndex).every((item) => item.compensation === "not-attempted")).toBe(true);
    const manifestIndex = plan.mutations.findIndex((mutation) => mutation.path === fixture.paths.manifest);
    expect(result.items[manifestIndex]?.compensation).toBe("not-attempted");
    expect(
      result.items
        .slice(claudeIndex + 1)
        .every(
          (item, offset) =>
            item.index === claudeIndex + 1 + offset &&
            (item.index === manifestIndex || item.compensation === "restored"),
        ),
    ).toBe(true);
    expect(readFileSync(fixture.paths.claudeJson)).toEqual(edited);
    expect(readFileSync(fixture.paths.codexSkill)).toEqual(installedSkill);
    expect(journalState(fixture)).toBe("needs-manual-repair");
  });

  it("keeps the manifest in step with the configs after a partial undo and finishes it on retry", () => {
    const fixture = createFixture();
    const before = snapshot(fixture);
    commit(fixture);
    const written = readFileSync(fixture.paths.codexConfig);
    writeFileSync(
      fixture.paths.codexConfig,
      written
        .toString("utf8")
        .replace("[mcp_servers.work-intelligence]", "[mcp_servers.work-intelligence]\nstartup_timeout_sec = 5"),
    );

    expect(undoAt(fixture).status).toBe("needs-manual-repair");

    const ids = (
      JSON.parse(readFileSync(fixture.paths.manifest, "utf8")) as { components: { id: string }[] }
    ).components.map((component) => component.id);
    const onDisk = {
      claudeMcp: readFileSync(fixture.paths.claudeJson, "utf8").includes("work-intelligence"),
      codexMcp: readFileSync(fixture.paths.codexConfig, "utf8").includes("work-intelligence"),
      codexSkill: existsSync(fixture.paths.codexSkill),
    };
    for (const [id, present] of Object.entries(onDisk)) expect(ids.includes(id), id).toBe(present);
    expect(onDisk.codexMcp).toBe(true);
    expect(Object.values(onDisk).some((present) => !present)).toBe(true);

    writeFileSync(fixture.paths.codexConfig, written);
    expect(undoAt(fixture).status).toBe("undone");
    expectSnapshot(before);
  });

  it("can be retried after the file is repaired and then finishes the undo", () => {
    const fixture = createFixture();
    const before = snapshot(fixture);
    commit(fixture);
    const written = readFileSync(fixture.paths.claudeJson);
    writeFileSync(fixture.paths.claudeJson, "{}\n");
    expect(undoAt(fixture).status).toBe("needs-manual-repair");

    writeFileSync(fixture.paths.claudeJson, written);
    expect(undoAt(fixture).status).toBe("undone");
    expectSnapshot(before);
  });

  it("is crash-safe: a crash mid-undo leaves a pending journal that recoverAgentSetupJournal finishes", () => {
    const fixture = createFixture();
    const before = snapshot(fixture);
    const plan = commit(fixture);
    let restored = 0;

    expect(() =>
      undoAt(fixture, {
        afterRestore: () => {
          restored += 1;
          if (restored === 2) throw new Error("simulated crash");
        },
      }),
    ).toThrow("simulated crash");
    expect(journalState(fixture)).toBe("pending");
    expect(snapshot(fixture)).not.toEqual(before);

    const recovery = recoverAgentSetupJournal(fixture.paths.journal, { homeDirectory: fixture.options.homeDirectory });

    expect(recovery.status).toBe("recovered");
    expect(recovery.items.filter((item) => item.compensation === "unchanged").length).toBe(2);
    expectSnapshot(before);
    expect(backupsOf(plan).some((path) => existsSync(path))).toBe(false);
    expect(journalState(fixture)).toBe("compensated");
    expect(undoAt(fixture).status).toBe("nothing-to-undo");
  });

  it("keeps the committed journal and its backups until the next operation starts, which then discards them", () => {
    const fixture = createFixture();
    const first = commit(fixture);
    expect(backupsOf(first).every((path) => existsSync(path))).toBe(true);
    const preExisting = first.mutations.find((mutation) => mutation.path === fixture.paths.codexConfig)?.backupPath;
    const created = first.mutations.find((mutation) => mutation.path === fixture.paths.claudeJson)?.backupPath;
    if (!preExisting || !created) throw new Error("fixture plan has no backups");
    // Pretend this backup was already there before the operation: it is not ours to delete.
    const read = readAgentSetupJournal(fixture.paths.journal);
    if (read.status !== "found") throw new Error("missing journal");
    for (const item of read.journal.items) if (item.backupPath === preExisting) delete item.backupCreated;
    writeAgentSetupJournal(fixture.paths.journal, read.journal);

    const second = commit(fixture, createAgentSetupPlan(fixture.options, "uninstall"));

    expect(existsSync(created)).toBe(false);
    expect(existsSync(preExisting)).toBe(true);
    expect(backupsOf(second).every((path) => existsSync(path))).toBe(true);
    // The undo that is possible now is the second operation's.
    expect(undoAt(fixture).status).toBe("undone");
    expect(readFileSync(fixture.paths.manifest, "utf8")).toContain("claudeMcp");
  });

  it("keeps the previous operation undoable when the next apply fails and rolls back", () => {
    const fixture = createFixture();
    const before = snapshot(fixture);
    const first = commit(fixture);
    const afterFirst = snapshot(fixture);
    const second = createAgentSetupPlan(fixture.options, "uninstall");

    const result = applyAgentSetupTransaction(second, {
      journalPath: fixture.paths.journal,
      afterWrite: () => {
        throw new Error("synthetic failure");
      },
    });

    expect(result.outcome).toBe("rolled-back");
    expectSnapshot(afterFirst);
    expect(backupsOf(first).every((path) => existsSync(path))).toBe(true);
    expect(journalState(fixture)).toBe("committed");
    expect(undoAt(fixture).status).toBe("undone");
    expectSnapshot(before);
  });

  it("does not let a plan without changes replace the journal that can still be undone", () => {
    const fixture = createFixture();
    const before = snapshot(fixture);
    commit(fixture);
    const idle = createAgentSetupPlan(fixture.options);
    expect(idle.mutations).toEqual([]);
    expect(applyAgentSetupTransaction(idle, { journalPath: fixture.paths.journal }).outcome).toBe("committed");

    expect(undoAt(fixture).status).toBe("undone");
    expectSnapshot(before);
  });

  it("keeps the previous journal and backups when the next apply is refused before it starts", () => {
    const fixture = createFixture();
    const first = commit(fixture);
    const refused = createAgentSetupPlan(fixture.options, "uninstall");
    refused.conflicts.push("synthetic conflict");
    expect(applyAgentSetupTransaction(refused, { journalPath: fixture.paths.journal }).outcome).toBe("refused");
    expect(backupsOf(first).every((path) => existsSync(path))).toBe(true);
    expect(undoAt(fixture).status).toBe("undone");
  });

  it("undoes an adoption of a hook group with a sibling hook and gives the group back byte for byte", () => {
    const fixture = createFixture();
    fixture.options = { ...fixture.options, platform: PLATFORM };
    const root = fixture.options.repositoryRoot;
    writeJson(fixture.paths.claudeSettings, {
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: commandForAgentHook(`${root}/apps/mcp/dist/finalize-reminder.js`, PLATFORM) },
              { type: "command", command: "my-notify.sh" },
            ],
          },
        ],
      },
    });
    const before = snapshot(fixture);
    const plan = createAgentSetupPlan(launcherOptions(fixture, [root]));
    expect(plan.conflicts).toEqual([]);
    commit(fixture, plan);
    expect(readFileSync(fixture.paths.claudeSettings, "utf8")).toContain("my-notify.sh");

    expect(undoAt(fixture).status).toBe("undone");
    expectSnapshot(before);
  });

  it("undoes an adoption and gives back the hand-written entries byte for byte", () => {
    const fixture = createFixture();
    fixture.options = { ...fixture.options, platform: PLATFORM };
    const root = fixture.options.repositoryRoot;
    const script = (name: string) => `${root}/apps/mcp/dist/${name}`;
    writeJson(fixture.paths.claudeJson, {
      numbers: [1, 2, 3],
      mcpServers: {
        "work-intelligence": {
          type: "stdio",
          command: "node",
          args: [script("launcher.js")],
          env: { WORK_INTELLIGENCE_DB: "data/mine.sqlite", API_TOKEN: "synthetic" },
        },
      },
    });
    writeJson(fixture.paths.claudeSettings, {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: commandForAgentHook(script("finalize-reminder.js"), PLATFORM) }] },
        ],
      },
    });
    mkdirSync(dirname(fixture.paths.codexConfig), { recursive: true });
    writeFileSync(
      fixture.paths.codexConfig,
      [
        "# prefs",
        "[mcp_servers.work-intelligence]",
        'command = "node"   # runtime',
        `args = [${JSON.stringify(script("index.js"))}]`,
        "",
        "[features]",
        "x = 1",
        "",
      ].join("\r\n"),
    );
    const before = snapshot(fixture);
    const options = launcherOptions(fixture, [root]);
    const plan = createAgentSetupPlan(options);
    expect(plan.conflicts).toEqual([]);
    expect(plan.adopted?.length).toBe(3);
    commit(fixture, plan);
    expect(readFileSync(fixture.paths.claudeJson, "utf8")).toContain(JSON.stringify(HOST_SHIM).slice(1, -1));
    expect(readFileSync(fixture.paths.codexConfig, "utf8")).toContain("# >>> Work Intelligence setup:agents >>>");

    const result = undoAt(fixture);

    expect(result.status).toBe("undone");
    expectSnapshot(before);
  });
});

describe("undoAgentSetupOperation after an Agent rewrote its config", () => {
  function parsed(path: string): Record<string, unknown> {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  }

  it("removes only our entry from a re-serialised Claude JSON that gained extra keys, then has nothing left to undo", () => {
    const fixture = createFixture();
    const before = snapshot(fixture);
    commit(fixture);
    const rewritten = parsed(fixture.paths.claudeJson);
    (rewritten.mcpServers as Record<string, unknown>).added = { command: "synthetic-added" };
    rewritten.numStartups = 7;
    rewritten.projects = { "/synthetic/project": { allowedTools: [] } };
    // Compact, differently indented: whole-file equality can never hold again.
    writeFileSync(fixture.paths.claudeJson, JSON.stringify(rewritten));

    const result = undoAt(fixture);

    expect(result.status).toBe("undone");
    expect(parsed(fixture.paths.claudeJson)).toEqual({
      mcpServers: { existing: { command: "node", args: ["existing.js"] }, added: { command: "synthetic-added" } },
      numStartups: 7,
      projects: { "/synthetic/project": { allowedTools: [] } },
    });
    // The files the Agent did not touch are back exactly, and the manifest follows.
    expect(existsSync(fixture.paths.manifest)).toBe(false);
    expect(readFileSync(fixture.paths.codexConfig)).toEqual(before.get(fixture.paths.codexConfig));
    expect(journalState(fixture)).toBe("compensated");

    const afterFirst = readFileSync(fixture.paths.claudeJson);
    expect(undoAt(fixture).status).toBe("nothing-to-undo");
    expect(readFileSync(fixture.paths.claudeJson)).toEqual(afterFirst);
  });

  it("keeps foreign hooks, in the same array and beside it, when it takes out its own hook groups", () => {
    const fixture = createFixture();
    commit(fixture);
    const settings = parsed(fixture.paths.claudeSettings) as { hooks: Record<string, unknown[]> };
    const foreignStop = { hooks: [{ type: "command", command: "synthetic-foreign-stop" }] };
    settings.hooks.Stop = [foreignStop, ...(settings.hooks.Stop ?? [])];
    settings.hooks.Notification = [{ hooks: [{ type: "command", command: "synthetic-notify" }] }];
    writeFileSync(fixture.paths.claudeSettings, JSON.stringify({ theme: "synthetic", ...settings }, null, 4));

    const result = undoAt(fixture);

    expect(result.status).toBe("undone");
    expect(parsed(fixture.paths.claudeSettings)).toEqual({
      theme: "synthetic",
      hooks: {
        Stop: [foreignStop],
        Notification: [{ hooks: [{ type: "command", command: "synthetic-notify" }] }],
      },
    });
    expect(existsSync(fixture.paths.manifest)).toBe(false);
  });

  it("removes only our Codex block from a config.toml the Agent rewrote around it", () => {
    const fixture = createFixture();
    commit(fixture);
    const written = readFileSync(fixture.paths.codexConfig, "utf8");
    expect(written).toContain("# >>> Work Intelligence setup:agents >>>");
    writeFileSync(
      fixture.paths.codexConfig,
      `# rewritten by the Agent\n${written}\n[projects."/synthetic/project"]\ntrust_level = "trusted"\n`,
    );

    const result = undoAt(fixture);

    expect(result.status).toBe("undone");
    const after = readFileSync(fixture.paths.codexConfig, "utf8");
    expect(after).not.toContain("work-intelligence");
    expect(after).toContain("# rewritten by the Agent");
    expect(after).toContain('model = "fixture-model"');
    expect(after).toContain('trust_level = "trusted"');
    expect(undoAt(fixture).status).toBe("nothing-to-undo");
  });

  it("re-verifies and leaves the file alone when our entry was altered, instead of guessing", () => {
    const fixture = createFixture();
    commit(fixture);
    editOurClaudeEntry(fixture);
    const edited = readFileSync(fixture.paths.claudeJson);

    const result = undoAt(fixture);

    expect(result.status).toBe("needs-manual-repair");
    expect(result.manualRepairPath).toBe(fixture.paths.claudeJson);
    expect(readFileSync(fixture.paths.claudeJson)).toEqual(edited);
  });
});
