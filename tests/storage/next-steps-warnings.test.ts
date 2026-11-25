import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/store.js";

// Fictional fixtures only.
const stores: WorkIntelligenceStore[] = [];
const tempDirs: string[] = [];
const TRANSIENT_STEP = "變更尚未 commit";
const LASTING_STEP = "補上離線備份的還原演練";

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "work-intelligence-next-steps-"));
  tempDirs.push(root);
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const project = store.addProject("Next steps fixture", root);
  store.updateProject(project.id, { status: "tracked" });
  const workSummary = (nextSteps: string[]) => ({
    outcomes: ["完成"],
    scope: ["範圍"],
    decisions: [],
    verification: ["已測試"],
    nextSteps,
  });
  const finalize = (key: string, nextSteps: string[]) =>
    store.finalizeSession({
      projectRoot: root,
      idempotencyKey: key,
      title: "Next steps",
      summary: "Next steps fixture",
      workSummary: workSummary(nextSteps),
      verification: { status: "passed" },
    });
  const baseSession = () => {
    const result = finalize("base", []);
    if (result.outcome !== "finalized") throw new Error("Expected a finalized Session.");
    return result.session.id;
  };
  return { store, workSummary, finalize, baseSession };
}

describe("nextSteps warnings on finalize", () => {
  it("warns about a transient item and keeps every item verbatim", () => {
    const { store, finalize } = setup();
    const result = finalize("warn", [LASTING_STEP, TRANSIENT_STEP]);
    if (result.outcome !== "finalized") throw new Error("Expected a finalized Session.");
    expect(result.nextStepsWarnings?.items).toEqual([{ index: 1, category: "uncommitted" }]);
    expect(store.getSessionDetail(result.session.id)?.session.workSummary?.nextSteps).toEqual([
      LASTING_STEP,
      TRANSIENT_STEP,
    ]);
  });

  it("omits the field when nothing matches or on an idempotent replay", () => {
    const { finalize } = setup();
    expect(finalize("clean", [LASTING_STEP])).not.toHaveProperty("nextStepsWarnings");
    expect(finalize("replay", [TRANSIENT_STEP])).toHaveProperty("nextStepsWarnings");
    const replay = finalize("replay", [TRANSIENT_STEP]);
    expect(replay).toMatchObject({ duplicate: true });
    expect(replay).not.toHaveProperty("nextStepsWarnings");
  });
});

describe("nextSteps warnings on workSummary update", () => {
  it("warns in replace mode and keeps the item", () => {
    const { store, workSummary, baseSession } = setup();
    const sessionId = baseSession();
    const result = store.updateSessionWorkSummary({
      sessionId,
      idempotencyKey: "replace-warn",
      workSummary: workSummary([LASTING_STEP, "PR 待合併"]),
    });
    if (result.outcome !== "work_summary_updated") throw new Error("Expected an updated workSummary.");
    expect(result.nextStepsWarnings?.items).toEqual([{ index: 1, category: "pending_merge" }]);
    expect(result.appliedWorkSummary.nextSteps).toEqual([LASTING_STEP, "PR 待合併"]);
  });

  it("warns in merge mode only when the patch supplies nextSteps", () => {
    const { store, baseSession } = setup();
    const sessionId = baseSession();
    const patched = store.updateSessionWorkSummary({
      sessionId,
      idempotencyKey: "patch-next-steps",
      mode: "patch",
      workSummary: { nextSteps: ["CI 執行中"] },
    });
    expect(patched).toMatchObject({ nextStepsWarnings: { items: [{ index: 0, category: "ci_running" }] } });

    const untouched = store.updateSessionWorkSummary({
      sessionId,
      idempotencyKey: "patch-outcomes",
      mode: "patch",
      workSummary: { outcomes: ["新的成果"] },
    });
    expect(untouched).toMatchObject({ outcome: "work_summary_updated", duplicate: false });
    expect(untouched).not.toHaveProperty("nextStepsWarnings");
  });

  it("omits the field on an idempotent replay", () => {
    const { store, baseSession } = setup();
    const input = {
      sessionId: baseSession(),
      idempotencyKey: "patch-replay",
      mode: "patch" as const,
      workSummary: { nextSteps: [TRANSIENT_STEP] },
    };
    expect(store.updateSessionWorkSummary(input)).toHaveProperty("nextStepsWarnings");
    const replay = store.updateSessionWorkSummary(input);
    expect(replay).toMatchObject({ duplicate: true });
    expect(replay).not.toHaveProperty("nextStepsWarnings");
  });
});
