import { describe, expect, it } from "vitest";
import type { TransientNextStepCategory } from "../../packages/core/src/index.js";
import { findTransientNextSteps } from "../../packages/storage/src/transient-next-steps.js";
import { bestOfMs, doublingGrowth, scaledLimit } from "../helpers/timing.js";

const POSITIVE_CASES: Array<[TransientNextStepCategory, string]> = [
  ["scope_exclusion", "未處理：舊版設定頁"],
  ["scope_exclusion", "不在本 PR 範圍的重構"],
  ["scope_exclusion", "Rewriting the importer is out of scope"],
  ["scope_exclusion", "Windows packaging is not in this PR scope"],
  ["unverified_platform", "Linux 上未實測"],
  ["unverified_platform", "只在 macOS 上驗證"],
  ["unverified_platform", "Only tested on macOS"],
  ["unverified_platform", "Not tested on Windows"],
  ["deferred_to_user", "依使用者決定暫緩"],
  ["deferred_to_user", "Deferred by the user until next release"],
  ["uncommitted", "本次修改尚未 commit"],
  ["uncommitted", "還沒commit 就要交接"],
  ["uncommitted", "修改尚未提交"],
  ["uncommitted", "程式碼未提交到 Git"],
  ["uncommitted", "Uncommitted changes remain in the worktree"],
  ["uncommitted", "The edits are not yet committed"],
  ["not_pushed", "分支尚未 push"],
  ["not_pushed", "未推送到遠端"],
  ["not_pushed", "commit 尚未推送"],
  ["not_pushed", "Two unpushed commits on the branch"],
  ["not_pushed", "Work is not yet pushed to origin"],
  ["pending_merge", "PR 待合併"],
  ["pending_merge", "PR #12 尚未 review"],
  ["pending_merge", "等待 merge 後再發佈"],
  ["pending_merge", "此分支尚未合併"],
  ["pending_merge", "尚未合回 main"],
  ["pending_merge", "還沒 併回 主線"],
  ["pending_merge", "未 merge 回 develop"],
  ["pending_merge", "尚未合入主分支"],
  ["pending_merge", "未併入 main"],
  ["pending_merge", "The pull request is not yet merged"],
  ["pending_merge", "PR is awaiting review"],
  ["pending_merge", "Waiting for review and merge"],
  ["pending_merge", "Branch not yet merged into main"],
  ["ci_running", "CI 執行中"],
  ["ci_running", "CI 還沒跑完"],
  ["ci_running", "等待 CI 結果"],
  ["ci_running", "CI is still running"],
  ["ci_running", "Waiting for the CI"],
  ["ci_running", "The pipeline is still running"],
  ["ci_running", "PR #42 新 commit 的 CI 尚未確認、尚未合併"],
  ["ci_running", "CI 尚在執行"],
  ["ci_running", "CI 尚未確認"],
  ["ci_running", "CI 結果尚未確認"],
  ["pending_merge", "已 commit a1b2c3d 並 push 至 origin/feature/orchard，尚未合併"],
  ["pending_merge", "PR #42 head a1b2c3d 保持 open，未合併、未設 auto-merge"],
  ["pending_merge", "已 push 但未合併"],
  ["uncommitted", "匯出修補在硬化階段進行中，尚未提交"],
  ["uncommitted", "本次修正尚未提交"],
  ["uncommitted", "工作樹有三個未提交變更"],
  ["uncommitted", "留有兩個未提交檔"],
  ["not_pushed", "annotated tag 尚未推送"],
  ["not_pushed", "feature/orchard 未推送"],
  ["phase_not_started", "階段 2 尚未開始"],
  ["phase_not_started", "Phase 3 未進行"],
  ["phase_not_started", "Stage 2 is not yet started"],
];

const PRODUCT_BEHAVIOUR_CASES = [
  "表單未提交時按鈕應停用",
  "若表單未提交，顯示提醒",
  "通知尚未推送給離線使用者",
  "待合併的重複聯絡人仍需人工確認",
  "資料未併入月報統計",
  "尚未開始的任務不顯示在看板",
  "CI 已跑完並通過",
  "the transaction is not committed until save",
  "push notifications are not pushed to muted users",
  "Improve 頁面待 review 的欄位提示",
  "尚未開始",
  "實作尚未開始，需由使用者另開 session",
  "修正表單未提交時按鈕應停用的問題",
  "審核未確認前不顯示結果",
  "檔案未合併時顯示衝突提示",
];

const REALISTIC_NEXT_STEPS = [
  "為離線備份補上還原演練",
  "Document the retry policy for the export worker",
  "評估是否要把報表排程改成每週一次",
  "Revisit the cache invalidation rules after the next release",
];

describe("findTransientNextSteps", () => {
  it.each(POSITIVE_CASES)("flags %s: %s", (category, text) => {
    expect(findTransientNextSteps([text])?.items).toEqual([{ index: 0, category }]);
  });

  it.each(PRODUCT_BEHAVIOUR_CASES)("ignores product behaviour: %s", (text) => {
    expect(findTransientNextSteps([text])).toBeUndefined();
  });

  it("reports the index and one category per matching item", () => {
    const warnings = findTransientNextSteps([
      "補上離線備份的還原演練",
      "變更尚未 commit，且 PR 待合併",
      "CI 執行中",
      "Phase 2 not yet started",
    ]);
    expect(warnings?.items).toEqual([
      { index: 1, category: "uncommitted" },
      { index: 2, category: "ci_running" },
      { index: 3, category: "phase_not_started" },
    ]);
    expect(warnings?.message).toEqual(expect.any(String));
  });

  it("returns undefined for empty input and never repeats item text", () => {
    expect(findTransientNextSteps([])).toBeUndefined();
    const text = "祕密專案代號 Falcon 的分支尚未 push";
    expect(JSON.stringify(findTransientNextSteps([text]))).not.toContain("Falcon");
  });
});

describe("findTransientNextSteps on adversarial input", () => {
  const ITEM_COUNT = 20;
  const ITEM_LENGTH = 4_000;
  const MAX_MILLISECONDS = 100;
  const REFERENCE_BUDGET_MS = 10;
  // Doubling the item length should about double the time; a quadratic pattern quadruples it.
  const MAX_DOUBLING_RATIO = 3.2;
  const RATIO_BASELINE_FLOOR_MS = 10;
  const UNITS = [
    "PR ",
    "分支",
    "尚未 ",
    "CI ",
    "phase ",
    "stage ",
    " ",
    "\t",
    "未 ",
    "not ",
    "pull request ",
    "pipeline ",
    "waiting for ",
    "uncommitted ",
    "PR 尚未",
    "分支尚未 ",
    "git 尚未",
    "PR 未",
    "origin/",
    "tag ",
    "未提交",
    "push 未",
    "branch not yet ",
  ];

  function fill(unit: string, length = ITEM_LENGTH): string {
    return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
  }

  function adversarialItems(length: number): string[] {
    return Array.from({ length: ITEM_COUNT }, (_, index) => fill(UNITS[index % UNITS.length]!, length));
  }

  const adversarial = UNITS.map((unit) => fill(unit));
  const items = Array.from({ length: ITEM_COUNT }, (_, index) => adversarial[index % adversarial.length]!);
  const realistic = Array.from({ length: ITEM_COUNT }, (_, index) =>
    fill(`${REALISTIC_NEXT_STEPS[index % REALISTIC_NEXT_STEPS.length]}。`),
  );

  it("scans pathological items in linear time", () => {
    const { limitMs } = scaledLimit({
      limitMs: MAX_MILLISECONDS,
      reference: () => findTransientNextSteps(realistic),
      referenceBudgetMs: REFERENCE_BUDGET_MS,
    });
    expect(bestOfMs(() => findTransientNextSteps(items))).toBeLessThan(limitMs);
    for (const item of adversarial) {
      expect(bestOfMs(() => findTransientNextSteps([item]), 2)).toBeLessThan(limitMs);
    }
  });

  it("takes about twice as long when the item length doubles", () => {
    const half = adversarialItems(ITEM_LENGTH / 2);
    const full = adversarialItems(ITEM_LENGTH);
    const { smallMs, largeMs } = doublingGrowth({
      small: () => findTransientNextSteps(half),
      large: () => findTransientNextSteps(full),
      floorMs: RATIO_BASELINE_FLOOR_MS,
      withinLimit: (small, large) => large < small * MAX_DOUBLING_RATIO,
    });
    expect(largeMs).toBeLessThan(smallMs * MAX_DOUBLING_RATIO);
  });
});
