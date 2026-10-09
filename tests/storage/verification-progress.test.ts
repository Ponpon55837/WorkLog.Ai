import { mkdtempSync, rmSync } from "node:fs";
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
