import type { NextStepsWarnings, TransientNextStepCategory } from "@work-intelligence/core";

const NEXT_STEPS_WARNING_MESSAGE =
  "這些 nextSteps 項目看起來是任務內的暫時狀態（未 commit、未 push、PR 待合併或未合回分支、CI 執行中、階段尚未開始），由關鍵字比對，可能誤判。若是本任務自己會完成的進度，請移到 outcomes 或 verification；若確實是之後要處理的事項則保留。伺服器未更動任何項目。";

const NOT_YET = String.raw`(?:尚未|還沒|未)`;
const TARGET_BRANCH = String.raw`(?:main|master|develop|trunk)`;

// Bounded windows only, so each scan is linear; an item gets at most three: strict, Git context, then bare state words.
const CATEGORY_SOURCES: Record<TransientNextStepCategory, readonly string[]> = {
  uncommitted: [
    String.raw`(?:尚未|還沒|未|待)\s{0,2}commit`,
    String.raw`(?:變更|修改|改動|程式碼|檔案)[^\n]{0,4}?${NOT_YET}\s{0,2}提交`,
    String.raw`${NOT_YET}\s{0,2}提交\s{0,2}(?:的\s{0,2})?(?:變更|檔案?|修改|修補)`,
    String.raw`${NOT_YET}\s{0,2}提交\s{0,2}(?:$|[\n。；;!！])`,
    String.raw`${NOT_YET}\s{0,2}提交\s{0,2}(?:到|至)?\s{0,2}git`,
    String.raw`uncommitted\s{1,3}(?:changes?|work|files?|edits?|diff)`,
    String.raw`(?:changes?|work|files?|edits?)\s{1,3}(?:(?:are|is)\s{1,3})?not\s{1,3}(?:yet\s{1,3})?committed`,
  ],
  not_pushed: [
    String.raw`(?:尚未|還沒|未|待)\s{0,2}push`,
    String.raw`${NOT_YET}\s{0,2}(?:推送|推上)\s{0,2}(?:到|至)?\s{0,2}(?:遠端|remote|origin|github|分支|branch)`,
    String.raw`(?:commit|分支|branch)[^\n]{0,6}?${NOT_YET}\s{0,2}(?:推送|推上)`,
    String.raw`unpushed\s{1,3}(?:commits?|changes?|branch)`,
    String.raw`not\s{1,3}(?:yet\s{1,3})?pushed\s{1,3}(?:to\s{1,3})?(?:the\s{1,3})?(?:remote|origin|branch|github)`,
  ],
  pending_merge: [
    String.raw`(?:\bPR\b|pull\s{1,3}request)[^\n]{0,12}?(?:尚未|還沒|未|待|等待)\s{0,2}(?:merge|合併|合入|審查|review)`,
    String.raw`(?:待|等待|等候)\s{0,2}merge`,
    String.raw`(?:分支|branch)[^\n]{0,8}?${NOT_YET}\s{0,2}(?:合併|合入|併入|merge)`,
    String.raw`${NOT_YET}\s{0,2}(?:合回|併回|merge\s{0,2}回)`,
    String.raw`${NOT_YET}\s{0,2}(?:合入|併入|合併)\s{0,2}(?:到|至|回)?\s{0,2}(?:主線|主分支|${TARGET_BRANCH})`,
    String.raw`(?:\bPR\b|pull\s{1,3}request)[^\n]{0,20}?(?:not\s{1,3}(?:yet\s{1,3})?merged|awaiting|pending\s{1,3}(?:review|merge)|waiting\s{1,3}(?:for|on))`,
    String.raw`(?:awaiting|waiting\s{1,3}(?:for|on))\s{1,3}(?:review\s{1,3}and\s{1,3})?merge`,
    String.raw`not\s{1,3}(?:yet\s{1,3})?merged\s{1,3}(?:back\s{1,3})?(?:in)?to\s{1,3}${TARGET_BRANCH}`,
  ],
  ci_running: [
    String.raw`\bCI\b[^\n]{0,12}?(?:執行中|進行中|尚未(?:完成|跑完)|還沒跑完|未跑完|尚在執行|仍在執行|還在跑|未確認|running|in\s{1,3}progress|pending)`,
    String.raw`(?:等待|等候|waiting\s{1,3}(?:for|on))\s{0,3}(?:the\s{1,3})?\bCI\b`,
    String.raw`pipeline\s{1,3}(?:(?:is|are)\s{1,3})?(?:still\s{1,3})?(?:running|in\s{1,3}progress|pending)`,
  ],
  phase_not_started: [
    String.raw`(?:階段|phase|stage)[^\n]{0,10}?${NOT_YET}\s{0,2}(?:開始|進行|執行)`,
    String.raw`(?:phase|stage)[^\n]{0,12}?not\s{1,3}(?:yet\s{1,3})?started`,
  ],
};

const BARE_SOURCES: Partial<Record<TransientNextStepCategory, readonly string[]>> = {
  uncommitted: [String.raw`${NOT_YET}\s{0,2}提交`],
  not_pushed: [String.raw`${NOT_YET}\s{0,2}(?:推送|推上)`],
  pending_merge: [String.raw`${NOT_YET}\s{0,2}(?:合併|merge)`, String.raw`not\s{1,3}(?:yet\s{1,3})?merged`],
};

const GIT_CONTEXT = new RegExp(
  [
    String.raw`\bPR\b`,
    String.raw`[Pp]ull\s{1,3}[Rr]equest`,
    String.raw`\b[Cc]ommit(?:s|ted)?\b`,
    String.raw`\b[Pp]ush(?:ed)?\b`,
    String.raw`\b[Oo]rigin\b`,
    "分支",
    String.raw`\b[Bb]ranch(?:es)?\b`,
    String.raw`\b[Tt]ag\b`,
    String.raw`\b[Ss]taged\b`,
    String.raw`\bHEAD\b`,
    String.raw`[Gg]it\s{1,3}index`,
    String.raw`\b[Gg]it\b`,
    String.raw`\b(?:feature|fix|hotfix|bugfix|release|chore|claude|codex)/[\w.-]`,
  ].join("|"),
);

function namedPattern(sources: Partial<Record<TransientNextStepCategory, readonly string[]>>): RegExp {
  const groups = Object.entries(sources).map(([category, alternatives]) => `(?<${category}>${alternatives.join("|")})`);
  return new RegExp(groups.join("|"), "i");
}

const STRICT_PATTERN = namedPattern(CATEGORY_SOURCES);
const BARE_PATTERN = namedPattern(BARE_SOURCES);
const CATEGORIES = Object.keys(CATEGORY_SOURCES) as TransientNextStepCategory[];

function categoryIn(pattern: RegExp, item: string): TransientNextStepCategory | undefined {
  const groups = pattern.exec(item)?.groups;
  return groups ? CATEGORIES.find((category) => groups[category] !== undefined) : undefined;
}

function categoryOf(item: string): TransientNextStepCategory | undefined {
  return categoryIn(STRICT_PATTERN, item) ?? (GIT_CONTEXT.test(item) ? categoryIn(BARE_PATTERN, item) : undefined);
}

/** Flags nextSteps that read like in-task Git/PR/CI state. Keyword matching only: callers must keep every item. */
export function findTransientNextSteps(nextSteps: readonly string[]): NextStepsWarnings | undefined {
  const items = nextSteps.flatMap((item, index) => {
    const category = categoryOf(item);
    return category ? [{ index, category }] : [];
  });
  return items.length > 0 ? { items, message: NEXT_STEPS_WARNING_MESSAGE } : undefined;
}
