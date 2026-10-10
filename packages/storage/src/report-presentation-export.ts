import { projectReportSummary, type ReportPresentation, type ReportSummary } from "@work-intelligence/core";

const labels = {
  "zh-TW": {
    version: "報告版本",
    revision: "呈現修訂",
    hidden: "已隱藏群組（內容未包含）",
    edited: "使用者改稿",
    sources: "來源 Sessions",
    allSources: "完整原報告來源（含隱藏群組）",
    sections: {
      themes: "工作主題",
      highlights: "主要成果",
      verification: "Verification",
      comparison: "期間比較",
      risks: "風險與限制",
      decisions: "決策",
      nextSteps: "狀態／未結項",
    },
  },
  "en-US": {
    version: "Report version",
    revision: "Presentation revision",
    hidden: "Hidden sections (content omitted)",
    edited: "User edited",
    sources: "Source Sessions",
    allSources: "Original report sources (including hidden sections)",
    sections: {
      themes: "Work themes",
      highlights: "Key outcomes",
      verification: "Verification",
      comparison: "Period comparison",
      risks: "Risks and limits",
      decisions: "Decisions",
      nextSteps: "Status / open items",
    },
  },
};

/** Escapes untrusted Markdown syntax and HTML, preserving readable text and line breaks. */
export function reportMarkdownText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\`*_{}[\]()#+!|]/g, "\\$&")
    .replace(/(^|\n)([-=~])/g, "$1\\$2");
}

/** Serializes the same immutable projection as the UI, without restoring hidden content. */
export function reportPresentationMarkdown(
  summary: ReportSummary,
  presentation: ReportPresentation,
  locale: "zh-TW" | "en-US",
): string {
  const l = labels[locale],
    text = reportMarkdownText;
  const lines = [
    `# ${text(summary.title)}`,
    "",
    `${text(summary.range.from)} — ${text(summary.range.to)}`,
    "",
    `${l.version}: ${text(summary.id)} · ${l.revision}: ${presentation.revision}`,
    "",
    text(summary.executiveSummary),
  ];
  if (presentation.state.hidden.length)
    lines.push("", `${l.hidden}: ${presentation.state.hidden.map((key) => l.sections[key]).join(", ")}`);
  for (const section of projectReportSummary(summary, presentation.state)) {
    lines.push("", `## ${l.sections[section.key]}`);
    for (const block of section.blocks)
      lines.push(
        "",
        `### ${text(block.title)}${block.edited ? ` (${l.edited})` : ""}`,
        "",
        text(block.detail),
        "",
        `${l.sources}: ${block.sourceSessionIds.map(text).join(", ")}`,
      );
  }
  lines.push("", `## ${l.allSources}`, ...summary.sourceSessionIds.map((id) => `- ${text(id)}`), "");
  return lines.join("\n");
}
