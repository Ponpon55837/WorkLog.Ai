import type { SessionDetail } from "@work-intelligence/core";
import { t } from "../i18n";
import { formatDate } from "./format";
import { workSummarySectionLabels } from "./labels";
import { verificationOf, verificationStatus } from "./status";

const MAX_LISTED_FILES = 20;
const SHORT_SHA_LENGTH = 7;

/** Markdown summary of one Session for pasting into a PR, standup message or handoff doc. */
export function sessionMarkdown(detail: SessionDetail): string {
  const { session, project } = detail;
  const blocks: string[] = [`# ${session.title}`];

  const verification = verificationStatus[verificationOf(session)].label;
  const verificationSummary = session.verification?.summary?.trim();
  const git = [session.gitBranch, session.commitSha?.slice(0, SHORT_SHA_LENGTH)].filter(Boolean).join(" @ ");
  const meta = [
    `- ${t("common.project")}: ${project.name}`,
    `- ${t("common.completed")}: ${formatDate(session.completedAt)}`,
    `- ${t("common.verification")}: ${verificationSummary ? `${verification} — ${verificationSummary}` : verification}`,
    ...(git ? [`- ${t("labels.git")}: ${git}`] : []),
    ...(session.voided ? [`- ${t("session.voidedLabel")}`] : []),
  ];
  blocks.push(meta.join("\n"));

  const summary = session.summary.trim();
  if (summary) blocks.push(summary);

  for (const { key, label } of workSummarySectionLabels) {
    const items = session.workSummary?.[key] ?? [];
    if (items.length > 0) blocks.push(`## ${label}\n${items.map((item) => `- ${item}`).join("\n")}`);
  }

  const files = session.changedFiles;
  if (files.length > 0) {
    const lines = files.slice(0, MAX_LISTED_FILES).map((file) => `- \`${file}\``);
    if (files.length > MAX_LISTED_FILES) {
      lines.push(`- ${t("session.markdownMoreFiles", { count: files.length - MAX_LISTED_FILES })}`);
    }
    // Changed files are file-change metadata, not a Git commit (docs/work-record-and-report-format.md).
    blocks.push(`## ${t("labels.changedFiles")}\n_${t("common.notTheSameAsGit")}_\n\n${lines.join("\n")}`);
  }

  return `${blocks.join("\n\n")}\n`;
}
