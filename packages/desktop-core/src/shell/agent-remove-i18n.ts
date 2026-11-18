import type { AgentsResult } from "./agents-state.js";
import { formatMessage, type ShellLocale } from "./i18n.js";
import { setupMessages } from "./setup-i18n.js";

/**
 * The strings of "移除 Agent 設定": the button, the preview that lists what would be removed, and the results. Kept in
 * their own file so the Agent page's main string table stays as it is; both languages define all of it. Plain words
 * only: the page never asks the user to run anything.
 */
export interface AgentRemoveMessages {
  readonly agentsRemove: string;
  /** Shown above the preview: what is and is not removed. */
  readonly agentsRemoveHint: string;
  readonly agentsRemovePreviewHeading: string;
  /** The button that applies the removal; nothing is written before it is pressed. */
  readonly agentsRemoveApply: string;
  /** The preview has no file: setup never wrote anything, or it is already gone. */
  readonly agentsRemoveNothing: string;
  /** `{count}`. */
  readonly agentsRemoved: string;
}

const zhTW: AgentRemoveMessages = {
  agentsRemove: "移除 Agent 設定",
  agentsRemoveHint: "只會移除 App 寫入的項目；Agent 其他的設定不會動。按「確認移除」之前不會寫入任何檔案。",
  agentsRemovePreviewHeading: "將要移除的設定",
  agentsRemoveApply: "確認移除",
  agentsRemoveNothing: "沒有可以移除的 Work Intelligence 設定。",
  agentsRemoved: "已移除 {count} 個檔案中的設定。請重新開啟 Agent。",
};

const en: AgentRemoveMessages = {
  agentsRemove: "Remove Agent setup",
  agentsRemoveHint:
    "Only what the App wrote is removed; the rest of the Agent's settings stay as they are. Nothing is written until you press “Confirm removal”.",
  agentsRemovePreviewHeading: "Settings that will be removed",
  agentsRemoveApply: "Confirm removal",
  agentsRemoveNothing: "There is no Work Intelligence setup to remove.",
  agentsRemoved: "Removed the setup from {count} file(s). Reopen your Agent.",
};

export function agentRemoveMessages(locale: ShellLocale): AgentRemoveMessages {
  return locale === "zh-TW" ? zhTW : en;
}

/**
 * What the Agent page says about the last result. A failure that left files it could not put back
 * (`manualRepairDisplay`) names exactly those files and does not claim that what was written was restored.
 */
export function agentsResultMessage(result: AgentsResult | null, locale: ShellLocale): string | undefined {
  if (!result) return undefined;
  const text = setupMessages(locale);
  if (result.kind === "applied") return formatMessage(text.agentsApplied, { count: String(result.changed) });
  if (result.kind === "removed") {
    return formatMessage(agentRemoveMessages(locale).agentsRemoved, { count: String(result.changed) });
  }
  if (result.kind === "undone") return text.agentsUndone;
  if (result.kind === "nothing-to-undo") return text.agentsNothingToUndo;
  if (result.manualRepairDisplay) return formatMessage(text.agentsManualRepair, { path: result.manualRepairDisplay });
  return formatMessage(text.agentsFailed, { code: result.code });
}
