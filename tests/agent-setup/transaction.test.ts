import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAgentSetupPlan,
  applyAgentSetupTransaction,
  createAgentSetupPlan,
  readAgentSetupJournal,
  recoverAgentSetupJournal,
  type AgentSetupJournal,
  type AgentSetupPlan,
  type AgentSetupRecoveryResult,
} from "@work-intelligence/agent-setup";
import { writeAgentSetupJournal } from "../../packages/agent-setup/src/journal.js";
import { createFixture, readJson, removeFixtures, type SetupFixture } from "./fixture.js";

function snapshotUserFiles(fixture: SetupFixture): Map<string, Buffer | null> {
  const paths = [
    fixture.paths.codexConfig,
    fixture.paths.codexHooks,
    fixture.paths.claudeJson,
    fixture.paths.claudeSettings,
    fixture.paths.manifest,
    fixture.paths.codexSkill,
  ];
  return new Map(paths.map((path) => [path, existsSync(path) ? readFileSync(path) : null]));
}

function expectSnapshot(snapshot: Map<string, Buffer | null>): void {
  for (const [path, bytes] of snapshot) {
    if (bytes === null) expect(existsSync(path), path).toBe(false);
    else expect(readFileSync(path), path).toEqual(bytes);
  }
}

function recoverAt(fixture: SetupFixture): AgentSetupRecoveryResult {
  return recoverAgentSetupJournal(fixture.paths.journal, { homeDirectory: fixture.options.homeDirectory });
}

/** A journal as a crashed apply leaves it, built by hand so a test can change its contents. */
function pendingJournal(plan: AgentSetupPlan): AgentSetupJournal {
  return {
    version: 1,
    operationId: "fixture-operation",
    state: "pending",
    startedAt: "2026-09-28T12:34:56.000Z",
    items: plan.mutations.map((mutation) => ({
      path: mutation.path,
      label: mutation.label,
      mode: mutation.mode,
      beforeFingerprint: mutation.beforeFingerprint,
      afterFingerprint: mutation.afterFingerprint,
      ...(mutation.backupPath ? { backupPath: mutation.backupPath, backupCreated: true } : {}),
      state: "writing" as const,
    })),
    createdDirectories: [],
  };
}

function writePendingJournal(fixture: SetupFixture, plan: AgentSetupPlan): AgentSetupJournal {
  const journal = pendingJournal(plan);
  writeFileSync(fixture.paths.journal, JSON.stringify(journal));
  return journal;
}

function indexOfPath(plan: AgentSetupPlan, path: string): number {
  const index = plan.mutations.findIndex((mutation) => mutation.path === path);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

afterEach(removeFixtures);

describe("plan fingerprints", () => {
  it("records the sha256 of every target as read at plan time, or absent", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const claudeJson = plan.mutations.find((mutation) => mutation.path === fixture.paths.claudeJson);
    const skill = plan.mutations.find((mutation) => mutation.path === fixture.paths.codexSkill);
    expect(claudeJson?.beforeFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(skill?.beforeFingerprint).toBe("absent");
    expect(plan.mutations.every((mutation) => mutation.afterFingerprint !== mutation.beforeFingerprint)).toBe(true);
  });
});

describe("applyAgentSetupTransaction", () => {
  it("commits a full install, verifies every file and keeps a committed journal", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const result = applyAgentSetupTransaction(plan, { journalPath: fixture.paths.journal });

    expect(result.outcome).toBe("committed");
    expect(result.items.length).toBe(plan.mutations.length);
    expect(result.items.every((item) => item.status === "written" && item.verify === "verified")).toBe(true);
    expect(existsSync(fixture.paths.manifest)).toBe(true);
    const journal = readAgentSetupJournal(fixture.paths.journal);
    expect(journal.status === "found" && journal.journal.state).toBe("committed");
    expect(JSON.stringify(journal)).not.toContain("fixture-model");
  });

  it.each([
    ["edited", (path: string) => writeFileSync(path, "{}\n")],
    ["deleted", (path: string) => rmSync(path)],
  ])("does not overwrite an existing file that was %s after the plan", (_name, change) => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const before = snapshotUserFiles(fixture);
    change(fixture.paths.claudeJson);
    before.set(
      fixture.paths.claudeJson,
      existsSync(fixture.paths.claudeJson) ? readFileSync(fixture.paths.claudeJson) : null,
    );

    const result = applyAgentSetupTransaction(plan, { journalPath: fixture.paths.journal });
    const target = indexOfPath(plan, fixture.paths.claudeJson);

    expect(result.outcome).toBe("rolled-back");
    expect(result.items[target]).toMatchObject({ status: "externally-modified", code: "externally-modified" });
    expect(result.items.slice(target + 1).every((item) => item.status === "skipped")).toBe(true);
    expectSnapshot(before);
  });

  it("does not overwrite a file that was created after the plan and compensates earlier writes", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const before = snapshotUserFiles(fixture);
    const created = fixture.paths.codexHooks;
    const target = indexOfPath(plan, created);
    expect(target).toBeGreaterThan(0);
    mkdirSync(dirname(created), { recursive: true });
    writeFileSync(created, '{"hooks":{}}\n');
    before.set(created, readFileSync(created));

    const result = applyAgentSetupTransaction(plan, { journalPath: fixture.paths.journal });

    expect(result.outcome).toBe("rolled-back");
    expect(result.items[target]?.status).toBe("externally-modified");
    expect(result.items.slice(0, target).every((item) => item.compensation === "restored")).toBe(true);
    expectSnapshot(before);
  });

  it("stops at an item changed between its turn and the one before it, and restores earlier items", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const before = snapshotUserFiles(fixture);
    const target = indexOfPath(plan, fixture.paths.claudeJson);
    const changed = Buffer.from('{ "mcpServers": {}, "edited": true }\n');
    const result = applyAgentSetupTransaction(plan, {
      journalPath: fixture.paths.journal,
      beforeWrite: (_mutation, index) => {
        if (index === target) writeFileSync(fixture.paths.claudeJson, changed);
      },
    });

    expect(result.outcome).toBe("rolled-back");
    expect(result.items[target]?.status).toBe("externally-modified");
    before.set(fixture.paths.claudeJson, changed);
    expectSnapshot(before);
  });

  it("compensates item 1 when the write of item 2 of 3 fails", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const before = snapshotUserFiles(fixture);
    const keep = plan.mutations.slice(0, 3);
    const three: AgentSetupPlan = { ...plan, mutations: keep };

    const result = applyAgentSetupTransaction(three, {
      journalPath: fixture.paths.journal,
      beforeWrite: (_mutation, index) => {
        if (index === 1) throw new Error("injected failure with /secret/path");
      },
    });

    expect(result.outcome).toBe("rolled-back");
    expect(result.code).toBe("write-failed");
    expect(result.items.map((item) => item.status)).toEqual(["written", "failed", "skipped"]);
    expect(result.items[0]?.compensation).toBe("restored");
    expect(JSON.stringify(result)).not.toContain("secret");
    expectSnapshot(before);
    for (const mutation of keep) if (mutation.backupPath) expect(existsSync(mutation.backupPath)).toBe(false);
    const journal = readAgentSetupJournal(fixture.paths.journal);
    expect(journal.status === "found" && journal.journal.state).toBe("compensated");
  });

  it("leaves an item changed externally after it was written and reports it for manual repair", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const three: AgentSetupPlan = { ...plan, mutations: plan.mutations.slice(0, 3) };
    const first = three.mutations[0];
    const second = three.mutations[1];
    if (!first || !second) throw new Error("fixture plan is too small");
    const edited = Buffer.from("edited by someone else\n");

    const result = applyAgentSetupTransaction(three, {
      journalPath: fixture.paths.journal,
      afterWrite: (_mutation, index) => {
        if (index === 0) writeFileSync(first.path, edited);
      },
      beforeWrite: (_mutation, index) => {
        if (index === 2) throw new Error("injected");
      },
    });

    expect(result.outcome).toBe("needs-manual-repair");
    expect(result.code).toBe("write-failed");
    expect(result.items[1]?.compensation).toBe("restored");
    expect(result.items[0]?.compensation).toBe("manual-repair");
    expect(readFileSync(first.path)).toEqual(edited);
    expect(existsSync(second.path)).toBe(second.before !== null);
    // The backup stays so the person can repair by hand.
    if (first.backupPath) expect(existsSync(first.backupPath)).toBe(true);
    const journal = readAgentSetupJournal(fixture.paths.journal);
    expect(journal.status === "found" && journal.journal.state).toBe("needs-manual-repair");
  });

  it("stops compensation at the first external change and leaves older items untouched", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const three: AgentSetupPlan = { ...plan, mutations: plan.mutations.slice(0, 3) };
    const [first, second] = three.mutations;
    if (!first || !second) throw new Error("fixture plan is too small");

    const result = applyAgentSetupTransaction(three, {
      journalPath: fixture.paths.journal,
      afterWrite: (_mutation, index) => {
        if (index === 1) writeFileSync(second.path, "edited later\n");
      },
      beforeWrite: (_mutation, index) => {
        if (index === 2) throw new Error("injected");
      },
    });

    expect(result.outcome).toBe("needs-manual-repair");
    expect(result.items.map((item) => item.compensation)).toEqual(["not-attempted", "manual-repair", "none"]);
    expect(readFileSync(first.path)).toEqual(first.after);
  });

  it("reports a verify mismatch and compensates when a written file changes before verification", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const last = plan.mutations.length - 1;
    const result = applyAgentSetupTransaction(plan, {
      journalPath: fixture.paths.journal,
      afterWrite: (mutation, index) => {
        if (index === last) writeFileSync(mutation.path, "tampered\n");
      },
    });

    expect(result.code).toBe("verify-mismatch");
    expect(result.items[last]?.verify).toBe("mismatch");
    expect(result.items[0]?.verify).toBe("verified");
    expect(result.outcome).toBe("needs-manual-repair");
  });

  it.skipIf(process.platform === "win32")("fails closed when a target became a symbolic link", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const before = snapshotUserFiles(fixture);
    const outside = join(fixture.temporaryRoot, "outside.json");
    writeFileSync(outside, "{}\n");
    rmSync(fixture.paths.claudeJson);
    symlinkSync(outside, fixture.paths.claudeJson);
    before.delete(fixture.paths.claudeJson);

    const result = applyAgentSetupTransaction(plan, { journalPath: fixture.paths.journal });

    expect(result.outcome).toBe("rolled-back");
    expect(result.items[indexOfPath(plan, fixture.paths.claudeJson)]).toMatchObject({
      status: "failed",
      code: "read-failed",
    });
    expect(readFileSync(outside, "utf8")).toBe("{}\n");
    expectSnapshot(before);
  });

  it("rolls back without touching any target when a backup cannot be created", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const before = snapshotUserFiles(fixture);
    const blocker = join(fixture.temporaryRoot, "blocker");
    writeFileSync(blocker, "a file where a directory is needed\n");
    const withBackup = plan.mutations.find((mutation) => mutation.backupPath);
    if (!withBackup) throw new Error("fixture plan has no backup");
    withBackup.backupPath = join(blocker, "nested", "backup");

    const result = applyAgentSetupTransaction(plan, { journalPath: fixture.paths.journal });

    expect(result).toMatchObject({ outcome: "rolled-back", code: "write-failed" });
    expect(result.items.every((item) => item.status === "skipped")).toBe(true);
    expectSnapshot(before);
  });

  it("refuses a plan with conflicts, an existing backup and an unfinished journal without writing", () => {
    const fixture = createFixture();
    const conflicted = { ...createAgentSetupPlan(fixture.options), conflicts: ["x"] };
    expect(applyAgentSetupTransaction(conflicted, { journalPath: fixture.paths.journal })).toMatchObject({
      outcome: "refused",
      code: "plan-has-conflicts",
    });

    const plan = createAgentSetupPlan(fixture.options);
    const backup = plan.mutations.find((mutation) => mutation.backupPath)?.backupPath;
    if (!backup) throw new Error("fixture plan has no backup");
    writeFileSync(backup, "taken\n");
    expect(applyAgentSetupTransaction(plan, { journalPath: fixture.paths.journal })).toMatchObject({
      outcome: "refused",
      code: "backup-exists",
    });
    rmSync(backup);

    writePendingJournal(fixture, plan);
    expect(applyAgentSetupTransaction(plan, { journalPath: fixture.paths.journal })).toMatchObject({
      outcome: "refused",
      code: "unfinished-journal",
    });
    expect(existsSync(fixture.paths.manifest)).toBe(false);
  });

  it("moves an unreadable journal aside instead of blocking every later apply, and reports it", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    writeFileSync(fixture.paths.journal, "not a journal");

    const result = applyAgentSetupTransaction(plan, { journalPath: fixture.paths.journal });

    expect(result).toMatchObject({ outcome: "committed", code: "journal-corrupt-moved" });
    expect(result.corruptJournalPath).toMatch(/\.journal\.json\.corrupt-\d{8}T\d{9}Z$/);
    expect(readFileSync(result.corruptJournalPath ?? "", "utf8")).toBe("not a journal");
    const journal = readAgentSetupJournal(fixture.paths.journal);
    expect(journal.status === "found" && journal.journal.state).toBe("committed");
  });

  it("moves a directory sitting on the journal path aside too", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    mkdirSync(fixture.paths.journal);
    expect(applyAgentSetupTransaction(plan, { journalPath: fixture.paths.journal })).toMatchObject({
      outcome: "committed",
      code: "journal-corrupt-moved",
    });
  });

  it("keeps the legacy apply free of a journal and of verification", () => {
    const fixture = createFixture();
    const result = applyAgentSetupPlan(createAgentSetupPlan(fixture.options));
    expect(result.applied).toBe(true);
    expect(existsSync(fixture.paths.journal)).toBe(false);
  });
});

describe("recoverAgentSetupJournal", () => {
  it("compensates an operation whose process died after two items were written", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const before = snapshotUserFiles(fixture);
    const crashed = `${fixture.temporaryRoot}-crashed`;
    // Freeze the disk exactly as a crash right after item 1 would leave it, then let the apply finish normally.
    applyAgentSetupTransaction(plan, {
      journalPath: fixture.paths.journal,
      afterWrite: (_mutation, index) => {
        if (index === 3) cpSync(fixture.temporaryRoot, crashed, { recursive: true });
      },
    });
    rmSync(fixture.temporaryRoot, { recursive: true, force: true });
    cpSync(crashed, fixture.temporaryRoot, { recursive: true });
    rmSync(crashed, { recursive: true, force: true });
    expect(existsSync(fixture.paths.manifest)).toBe(false);
    const pending = readAgentSetupJournal(fixture.paths.journal);
    expect(pending.status === "found" && pending.journal.state).toBe("pending");

    const recovery = recoverAt(fixture);

    expect(recovery.status).toBe("recovered");
    expect(recovery.items.filter((item) => item.compensation === "restored").length).toBe(4);
    expectSnapshot(before);
    for (const mutation of plan.mutations) if (mutation.backupPath) expect(existsSync(mutation.backupPath)).toBe(false);
    expect(recoverAt(fixture).status).toBe("already-final");
    // Home still exists; only files of the interrupted operation were touched.
    expect(readdirSync(fixture.options.homeDirectory).length).toBeGreaterThan(0);
  });

  it("leaves a crashed item that someone else edited and reports manual repair", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const crashed = `${fixture.temporaryRoot}-crashed`;
    applyAgentSetupTransaction(plan, {
      journalPath: fixture.paths.journal,
      afterWrite: (_mutation, index) => {
        if (index === 3) cpSync(fixture.temporaryRoot, crashed, { recursive: true });
      },
    });
    rmSync(fixture.temporaryRoot, { recursive: true, force: true });
    cpSync(crashed, fixture.temporaryRoot, { recursive: true });
    rmSync(crashed, { recursive: true, force: true });
    const third = plan.mutations[2];
    if (!third) throw new Error("fixture plan is too small");
    writeFileSync(third.path, "edited after the crash\n");

    const recovery = recoverAt(fixture);

    expect(recovery.status).toBe("needs-manual-repair");
    expect(readFileSync(third.path, "utf8")).toBe("edited after the crash\n");
    expect(recovery.items[2]?.compensation).toBe("manual-repair");
    expect(recovery.items[1]?.compensation).toBe("not-attempted");
    expect(readAgentSetupJournal(fixture.paths.journal)).toMatchObject({
      status: "found",
      journal: { state: "needs-manual-repair" },
    });
  });

  it("reports a missing journal, moves an unreadable one aside, and ignores a committed one", () => {
    const fixture = createFixture();
    expect(recoverAt(fixture)).toEqual({ status: "none", items: [] });
    writeFileSync(fixture.paths.journal, "{}");
    const moved = recoverAt(fixture);
    expect(moved).toMatchObject({ status: "moved-aside", code: "journal-corrupt-moved", items: [] });
    expect(readFileSync(moved.corruptJournalPath ?? "", "utf8")).toBe("{}");
    expect(existsSync(fixture.paths.journal)).toBe(false);
    const plan = createAgentSetupPlan(fixture.options);
    applyAgentSetupTransaction(plan, { journalPath: fixture.paths.journal });
    const manifest = readFileSync(fixture.paths.manifest);
    expect(recoverAt(fixture).status).toBe("already-final");
    expect(readFileSync(fixture.paths.manifest)).toEqual(manifest);
    expect(readJson(fixture.paths.claudeJson).mcpServers).toBeDefined();
  });

  it("reports a failed compensation when the backup copy is gone", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const crashed = `${fixture.temporaryRoot}-crashed`;
    applyAgentSetupTransaction(plan, {
      journalPath: fixture.paths.journal,
      afterWrite: (_mutation, index) => {
        if (index === 4) cpSync(fixture.temporaryRoot, crashed, { recursive: true });
      },
    });
    rmSync(fixture.temporaryRoot, { recursive: true, force: true });
    cpSync(crashed, fixture.temporaryRoot, { recursive: true });
    rmSync(crashed, { recursive: true, force: true });
    for (const mutation of plan.mutations) if (mutation.backupPath) rmSync(mutation.backupPath, { force: true });

    const recovery = recoverAt(fixture);

    expect(recovery.status).toBe("needs-manual-repair");
    expect(recovery.items.some((item) => item.compensation === "failed")).toBe(true);
  });
});

describe("recovery refuses a journal that names files setup does not own", () => {
  function expectRefusedUntouched(fixture: SetupFixture, journal: AgentSetupJournal, victim: string): void {
    writeFileSync(fixture.paths.journal, JSON.stringify(journal));
    const before = readFileSync(victim);

    const recovery = recoverAt(fixture);

    expect(recovery).toMatchObject({ status: "needs-manual-repair", code: "journal-paths-invalid" });
    expect(recovery.items.every((item) => item.compensation === "none")).toBe(true);
    expect(readFileSync(victim)).toEqual(before);
    const after = readAgentSetupJournal(fixture.paths.journal);
    expect(after.status === "found" && after.journal.state).toBe("needs-manual-repair");
  }

  it("does not restore over a path that is not a setup target", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const victim = join(fixture.temporaryRoot, "victim.txt");
    writeFileSync(victim, "precious\n");
    const journal = pendingJournal(plan);
    const [first] = journal.items;
    if (!first) throw new Error("fixture plan is empty");
    first.path = victim;
    first.afterFingerprint = "absent";
    first.beforeFingerprint = "absent";
    expectRefusedUntouched(fixture, journal, victim);
  });

  it("does not delete a backup path that is not a sibling named like a setup backup", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const victim = join(fixture.temporaryRoot, "victim.txt");
    writeFileSync(victim, "precious\n");
    for (const backupPath of [victim, `${fixture.paths.claudeJson}.other-name`]) {
      const journal = pendingJournal(plan);
      const item = journal.items.find((candidate) => candidate.backupPath);
      if (!item) throw new Error("fixture plan has no backup");
      item.backupPath = backupPath;
      expectRefusedUntouched(fixture, journal, victim);
    }
  });

  it("does not remove a created directory that is not a parent of a setup target", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const victim = join(fixture.options.homeDirectory, "Documents");
    mkdirSync(victim);
    writeFileSync(join(victim, "keep.txt"), "x");
    for (const directory of [victim, fixture.options.homeDirectory, fixture.temporaryRoot]) {
      const journal = pendingJournal(plan);
      journal.createdDirectories = [directory];
      expectRefusedUntouched(fixture, journal, join(victim, "keep.txt"));
    }
    expect(existsSync(victim)).toBe(true);
  });

  it("still recovers when Agent config directories live outside the home", () => {
    const fixture = createFixture();
    const codexHomeDirectory = join(fixture.temporaryRoot, "elsewhere", "codex");
    const options = { ...fixture.options, codexHomeDirectory };
    const plan = createAgentSetupPlan(options);
    const target = plan.mutations.find((mutation) => mutation.path.startsWith(codexHomeDirectory));
    if (!target) throw new Error("fixture plan has no Codex target");
    const journal = { ...pendingJournal({ ...plan, mutations: [target] }), createdDirectories: [codexHomeDirectory] };
    writeFileSync(fixture.paths.journal, JSON.stringify(journal));

    const recovery = recoverAgentSetupJournal(fixture.paths.journal, {
      homeDirectory: options.homeDirectory,
      codexHomeDirectory,
    });

    expect(recovery.code).toBeUndefined();
    expect(recovery.status).not.toBe("needs-manual-repair");
  });
});

describe("journal and backup failures", () => {
  it("refuses without writing anything when the journal cannot be written", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const before = snapshotUserFiles(fixture);

    const result = applyAgentSetupTransaction(plan, {
      journalPath: fixture.paths.journal,
      writeJournal: () => {
        throw new Error("disk full");
      },
    });

    expect(result).toMatchObject({ outcome: "refused", code: "journal-write-failed" });
    expect(result.items.every((item) => item.status === "skipped")).toBe(true);
    expectSnapshot(before);
    for (const mutation of plan.mutations) if (mutation.backupPath) expect(existsSync(mutation.backupPath)).toBe(false);
  });

  it("compensates a whole finished apply when the commit mark cannot be written", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const before = snapshotUserFiles(fixture);
    let calls = 0;
    const attempts: string[] = [];

    const result = applyAgentSetupTransaction(plan, {
      journalPath: fixture.paths.journal,
      writeJournal: (path, journal) => {
        calls += 1;
        attempts.push(journal.state);
        if (journal.state === "committed") throw new Error("disk full");
        writeAgentSetupJournal(path, journal);
      },
    });

    expect(calls).toBeGreaterThan(plan.mutations.length);
    expect(attempts).toContain("committed");
    expect(result).toMatchObject({ outcome: "rolled-back", code: "journal-write-failed" });
    expect(result.items.every((item) => item.compensation === "restored")).toBe(true);
    expectSnapshot(before);
    for (const mutation of plan.mutations) if (mutation.backupPath) expect(existsSync(mutation.backupPath)).toBe(false);
    const journal = readAgentSetupJournal(fixture.paths.journal);
    expect(journal.status === "found" && journal.journal.state).toBe("compensated");
  });

  it("stops and compensates when the journal cannot be written before an item", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const before = snapshotUserFiles(fixture);
    let writing = 0;

    const result = applyAgentSetupTransaction(plan, {
      journalPath: fixture.paths.journal,
      writeJournal: (path, journal) => {
        if (journal.items.some((item) => item.state === "writing")) {
          writing += 1;
          if (writing === 3) throw new Error("disk full");
        }
        writeAgentSetupJournal(path, journal);
      },
    });

    expect(result).toMatchObject({ outcome: "rolled-back", code: "journal-write-failed" });
    expectSnapshot(before);
  });

  it("never deletes a backup it did not create when the backup name was taken in the race", () => {
    const fixture = createFixture();
    const plan = createAgentSetupPlan(fixture.options);
    const before = snapshotUserFiles(fixture);
    const withBackup = plan.mutations.filter((mutation) => mutation.backupPath);
    const [first, second] = withBackup;
    if (!first?.backupPath || !second?.backupPath) throw new Error("fixture plan needs two backups");
    let raced = false;

    // The plan checked the name was free; someone takes it after the pre-checks and before the backups are made.
    const result = applyAgentSetupTransaction(plan, {
      journalPath: fixture.paths.journal,
      writeJournal: (path, journal) => {
        if (!raced) {
          raced = true;
          writeFileSync(second.backupPath ?? "", "someone else's backup\n");
        }
        writeAgentSetupJournal(path, journal);
      },
    });

    expect(result).toMatchObject({ outcome: "rolled-back", code: "write-failed" });
    expect(readFileSync(second.backupPath, "utf8")).toBe("someone else's backup\n");
    expect(existsSync(first.backupPath)).toBe(false);
    const journal = readAgentSetupJournal(fixture.paths.journal);
    expect(journal.status === "found" && journal.journal.items.map((item) => item.backupCreated)).toContain(true);
    expectSnapshot(before);
  });
});
