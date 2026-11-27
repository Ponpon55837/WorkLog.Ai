import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VerificationStatus } from "../../packages/core/src/index.js";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

const stores: WorkIntelligenceStore[] = [];
const directories: string[] = [];

function setup() {
  const root = mkdtempSync(join(tmpdir(), "wi-progress-fixture-"));
  directories.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Fictional progress", root);
  store.updateProject(project.id, { status: "tracked" });
  function finalize(key: string, status: VerificationStatus | undefined = "in_progress") {
    const result = store.finalizeSession({
      projectRoot: root,
      idempotencyKey: key,
      title: `Fixture ${key}`,
      summary: "Synthetic completed checkpoint.",
      changedFiles: [],
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      ...(status ? { verification: { status } } : {}),
    });
    if (result.outcome !== "finalized") throw new Error("Expected tracked fixture");
    return result;
  }
  return { store, project, root, finalize };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("in-progress verification", () => {
  it("keeps audited not-run → in-progress → passed transitions in the same record without backfill gaps", () => {
    const { store, finalize, project } = setup();
    const id = finalize("audit", "not_run").session.id;
    expect(
      store.updateSessionVerification(id, { status: "in_progress", summary: "Synthetic test underway." }, "web"),
    ).toMatchObject({ outcome: "updated", previous: { status: "not_run" } });
    expect(
      store.updateSessionVerification(id, { status: "in_progress", summary: "Synthetic test underway." }, "web"),
    ).toMatchObject({ unchanged: true });
    const preview = store.previewMetadataBackfill({ projectRoot: project.rootPath });
    expect(preview).toMatchObject({
      outcome: "backfill_preview",
      items: [],
      totals: { needsBackfill: 0, verificationMissing: 0, verificationNotRun: 0 },
    });
    store.updateSessionVerification(id, { status: "passed" }, "web");
    expect(store.getSessionDetail(id)?.verificationHistory).toMatchObject([
      { previous: { status: "in_progress" }, resulting: { status: "passed" }, source: "web" },
      { previous: { status: "not_run" }, resulting: { status: "in_progress" }, source: "web" },
    ]);
    expect(store.listSessions({ projectId: project.id })).toHaveLength(1);
  });

  it("counts every progress record beyond the source cap and preserves all five report states", () => {
    const { store, finalize, project } = setup();
    for (let index = 0; index < 205; index++) finalize(`progress-${index}`);
    finalize("passed", "passed");
    finalize("failed", "failed");
    finalize("not-run", "not_run");
    // Historical imports may omit verification; never rewrite their missing value.
    const missing = store.finalizeSession({
      projectRoot: project.rootPath,
      idempotencyKey: "legacy",
      title: "Legacy",
      summary: "Synthetic historical record.",
    });
    expect(missing.outcome).toBe("finalized");
    const report = store.getReport({ period: "day", projectId: project.id });
    if (report.outcome !== "report") throw new Error("Expected report");
    expect(report.sessions).toHaveLength(200);
    expect(report.totals.verification).toEqual({ passed: 1, failed: 1, in_progress: 205, not_run: 1, not_supplied: 1 });
    expect(report.risks.find((risk) => risk.label === "Verification 進行中")?.sourceSessionIds.length).toBeGreaterThan(
      0,
    );
    const exported = store.exportReport({ period: "day", projectId: project.id, format: "markdown" });
    expect(exported).toMatchObject({ outcome: "report_export" });
    if (exported.outcome === "report_export") expect(exported.content).toContain("| In progress | 205 |");
  });

  it("round-trips progress verification and audit history through portable exports", () => {
    const { store, finalize, project } = setup();
    const id = finalize("portable", "not_run").session.id;
    store.updateSessionVerification(id, { status: "in_progress" }, "web");
    const bundle = store.exportProjectData({ type: "project", projectId: project.id });
    const destination = new WorkIntelligenceStore(":memory:");
    stores.push(destination);
    expect(destination.importProjectData({ bundle })).toMatchObject({ outcome: "project_data_imported" });
    const imported = destination.exportProjectData({ type: "all" });
    expect(JSON.parse(String(imported.tables.sessions[0]?.verification_json))).toEqual({ status: "in_progress" });
    expect(JSON.parse(String(imported.tables.session_verification_updates[0]?.resulting_json))).toEqual({
      status: "in_progress",
    });
    expect(JSON.parse(String(imported.tables.session_verification_updates[0]?.previous_json))).toEqual({
      status: "not_run",
    });
  });
});

describe("completing an in-progress start record with the same idempotencyKey", () => {
  function request(root: string, overrides: Record<string, unknown> = {}) {
    return {
      projectRoot: root,
      idempotencyKey: "start-then-finish",
      title: "Fictional ledger rounding",
      summary: "Started fictional ledger rounding.",
      changedFiles: [],
      workSummary: { outcomes: [], scope: [], decisions: [], verification: [], nextSteps: [] },
      verification: { status: "in_progress" as const },
      ...overrides,
    };
  }

  const completion = {
    title: "Fictional ledger rounding settled",
    summary: "Settled fictional ledger rounding.",
    changedFiles: ["src/ledger.ts"],
    workSummary: {
      outcomes: ["Rounding settled."],
      scope: ["ledger"],
      decisions: [],
      verification: ["Synthetic suite passed."],
      nextSteps: ["Check the fictional export format."],
    },
    verification: { status: "passed" as const, summary: "Synthetic suite passed." },
    git: { commitSha: "a".repeat(40), branch: "fiction" },
  };

  it("rewrites the same Session in place and creates outstanding items only from the completing nextSteps", () => {
    const { store, root, project } = setup();
    const started = store.finalizeSession(request(root, { startedAt: "2020-01-01T00:00:00.000Z" }));
    if (started.outcome !== "finalized") throw new Error("Expected tracked fixture");
    expect(store.listOutstandingItems({ projectId: project.id })).toMatchObject({ items: [] });

    const completed = store.finalizeSession(request(root, completion));
    if (completed.outcome !== "finalized") throw new Error("Expected completed finalize");

    expect(completed.duplicate).toBe(false);
    expect(completed.session.id).toBe(started.session.id);
    expect(completed.session.createdAt).toBe(started.session.createdAt);
    expect(completed.session).toMatchObject({
      title: completion.title,
      summary: completion.summary,
      changedFiles: ["src/ledger.ts"],
      commitSha: "a".repeat(40),
      gitBranch: "fiction",
      startedAt: "2020-01-01T00:00:00.000Z",
      verification: { status: "passed" },
      workSummary: { outcomes: ["Rounding settled."], nextSteps: ["Check the fictional export format."] },
    });
    expect(store.listSessions({ projectId: project.id })).toHaveLength(1);
    const detail = store.getSessionDetail(started.session.id);
    expect(detail?.events.filter((event) => event.type === "finalized")).toHaveLength(1);
    expect(detail?.verificationHistory).toMatchObject([
      { previous: { status: "in_progress" }, resulting: { status: "passed" } },
    ]);
    const items = store.listOutstandingItems({ projectId: project.id });
    expect(items).toMatchObject({
      items: [{ text: "Check the fictional export format.", sourceSessionId: started.session.id }],
    });
  });

  it("completes the start record even when the summary is unchanged", () => {
    const { store, root } = setup();
    const started = store.finalizeSession(request(root));
    const completed = store.finalizeSession(request(root, { verification: { status: "passed" } }));
    if (started.outcome !== "finalized" || completed.outcome !== "finalized") throw new Error("Expected finalized");
    expect(completed.duplicate).toBe(false);
    expect(completed.session).toMatchObject({ id: started.session.id, verification: { status: "passed" } });
  });

  it("does not downgrade a completed Session when the start payload is retried late", () => {
    const { store, root, project } = setup();
    store.finalizeSession(request(root));
    const completed = store.finalizeSession(request(root, completion));
    if (completed.outcome !== "finalized") throw new Error("Expected completed finalize");

    const lateRetry = store.finalizeSession(request(root));

    expect(lateRetry).toMatchObject({ outcome: "idempotency_conflict", sessionId: completed.session.id });
    expect(store.getSessionById(completed.session.id)).toMatchObject({
      summary: completion.summary,
      verification: { status: "passed" },
    });
    expect(store.listSessions({ projectId: project.id })).toHaveLength(1);
  });

  it("returns the stored Session as a duplicate for an identical completed payload and conflicts on a different one", () => {
    const { store, root } = setup();
    store.finalizeSession(request(root));
    store.finalizeSession(request(root, completion));

    expect(store.finalizeSession(request(root, completion))).toMatchObject({ outcome: "finalized", duplicate: true });
    expect(
      store.finalizeSession(request(root, { ...completion, summary: "Another fictional summary." })),
    ).toMatchObject({
      outcome: "idempotency_conflict",
    });
  });

  it("updates the start record in place when an in_progress finalize repeats with different content", () => {
    const { store, root, project } = setup();
    const started = store.finalizeSession(request(root));
    const repeated = store.finalizeSession(request(root, { summary: "Still on fictional ledger rounding." }));
    if (started.outcome !== "finalized" || repeated.outcome !== "finalized") throw new Error("Expected finalized");

    expect(repeated.duplicate).toBe(false);
    expect(repeated.session).toMatchObject({
      id: started.session.id,
      summary: "Still on fictional ledger rounding.",
      verification: { status: "in_progress" },
    });
    expect(store.listSessions({ projectId: project.id })).toHaveLength(1);
    expect(store.finalizeSession(request(root, { summary: "Still on fictional ledger rounding." }))).toMatchObject({
      duplicate: true,
    });
  });

  it("keeps one handoff snapshot when the completing finalize captures the handoff again", () => {
    const { store, root } = setup();
    writeFileSync(join(root, "handoff.md"), "# Fictional handoff\n\nStarted.\n", "utf8");
    const started = store.finalizeSession(request(root, { handoffPath: "handoff.md" }));
    if (started.outcome !== "finalized") throw new Error("Expected tracked fixture");
    writeFileSync(join(root, "handoff.md"), "# Fictional handoff\n\nSettled.\n", "utf8");
    store.finalizeSession(request(root, { ...completion, handoffPath: "handoff.md" }));

    const detail = store.getSessionDetailForAgent({ sessionId: started.session.id, includeRawSnapshots: true });
    const snapshots = JSON.stringify(detail);
    expect(snapshots).toContain("Settled.");
    expect(snapshots).not.toContain("Started.\\n");
  });

  it("creates no outstanding items or nextSteps warnings for a start record without nextSteps", () => {
    const { store, root, project } = setup();
    const started = store.finalizeSession(request(root));
    if (started.outcome !== "finalized") throw new Error("Expected tracked fixture");

    expect(started.outstandingItemWarnings).toBeUndefined();
    expect(started.nextStepsWarnings).toBeUndefined();
    expect(store.listOutstandingItems({ projectId: project.id })).toMatchObject({ items: [] });
  });
});
