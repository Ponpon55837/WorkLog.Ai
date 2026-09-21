import type { ReportMetricComparison, WorkReport } from "@work-intelligence/core";

function markdownInline(value: string | number | undefined): string {
  return String(value ?? "—")
    .replace(/\r?\n/g, " ")
    .replaceAll("|", "\\|")
    .trim();
}

function reportMetricMarkdown(label: string, metric: ReportMetricComparison): string {
  const delta = metric.delta > 0 ? "+" + metric.delta : String(metric.delta);
  return "| " + label + " | " + metric.current + " | " + metric.previous + " | " + delta + " |";
}

/** Deterministic report presentation and filename policy, independent of SQLite queries. */
export class ReportBuilder {
  public filenamePart(value: string): string {
    const normalized = value
      .normalize("NFKC")
      .replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return normalized || "all-projects";
  }

  public toMarkdown(report: WorkReport): string {
    const projectLabel = report.project?.name ?? "所有 tracked projects";
    const lines: string[] = [
      "# Work Intelligence 工作報告",
      "",
      "- 報告類型：" + report.period,
      "- 報告區間：" + report.range.from + " 至 " + report.range.to,
      "- 上一期：" + report.previousRange.from + " 至 " + report.previousRange.to,
      "- 專案範圍：" + markdownInline(projectLabel),
      "- 時區：" + report.timezone,
      "",
      "## 期間摘要",
      "",
      report.periodSummary,
      "",
      "## 上一期比較",
      "",
      "| 指標 | 本期 | 上一期 | 差異 |",
      "| --- | ---: | ---: | ---: |",
      reportMetricMarkdown("Sessions", report.comparison.sessions),
      reportMetricMarkdown("Events", report.comparison.events),
      reportMetricMarkdown("Changed files", report.comparison.changedFiles),
      "",
      "## 主要完成事項",
      ""
    ];

    if (report.sessions.length === 0) {
      lines.push("這段期間沒有可彙整的完成工作。", "");
    } else {
      for (const session of report.sessions) {
        const projectSuffix = session.projectName ? " · " + markdownInline(session.projectName) : "";
        lines.push(
          "- **" + markdownInline(session.title) + "** — " +
            markdownInline(session.summary) +
            "（" + session.completedAt.slice(0, 10) + projectSuffix + "）"
        );
      }
      lines.push("");
    }

    lines.push(
      "## Verification 狀態",
      "",
      "| 狀態 | 筆數 |",
      "| --- | ---: |",
      "| Passed | " + report.totals.verification.passed + " |",
      "| Failed | " + report.totals.verification.failed + " |",
      "| Not run | " + report.totals.verification.not_run + " |",
      "| Not supplied | " + report.totals.verification.not_supplied + " |",
      ""
    );

    lines.push("## 風險與待確認事項", "");
    if (report.risks.length === 0) {
      lines.push("目前期間沒有資料型風險。", "");
    } else {
      for (const risk of report.risks) {
        lines.push(
          "- **" + markdownInline(risk.label) + "** — " +
            markdownInline(risk.detail) +
            "（來源 Session：" + risk.sourceSessionIds.length + "）"
        );
      }
      lines.push("");
    }

    lines.push("## 決策與 Closing", "");
    if (report.decisions.length === 0) {
      lines.push("這段期間沒有決策事件。", "");
    } else {
      for (const decision of report.decisions) {
        lines.push(
          "- **" + markdownInline(decision.summary) + "** — " +
            markdownInline(decision.sessionTitle) +
            "（" + decision.occurredAt + "）"
        );
      }
      lines.push("");
    }

    lines.push(
      "## 活動趨勢",
      "",
      "| 日期 | Sessions | Events |",
      "| --- | ---: | ---: |"
    );
    for (const trend of report.trends) {
      lines.push("| " + trend.date + " | " + trend.sessions + " | " + trend.events + " |");
    }
    lines.push("");

    lines.push("## 專案分布", "");
    if (report.projects.length === 0) {
      lines.push("目前期間沒有 tracked project 資料。", "");
    } else {
      lines.push(
        "| 專案 | Sessions | Events | Source sessions |",
        "| --- | ---: | ---: | ---: |"
      );
      for (const project of report.projects) {
        lines.push(
          "| " + markdownInline(project.projectName) +
            " | " + project.sessionCount +
            " | " + project.eventCount +
            " | " + project.sourceSessionIds.length + " |"
        );
      }
      lines.push("");
    }

    lines.push("## 來源證據", "");
    if (report.evidence.length === 0) {
      lines.push("目前期間沒有可呈現的來源證據。", "");
    } else {
      for (const evidence of report.evidence) {
        const reference = evidence.reference ? " · " + markdownInline(evidence.reference) : "";
        lines.push(
          "- **" + markdownInline(evidence.label) + "** — " +
            markdownInline(evidence.detail) +
            "（" + markdownInline(evidence.sessionTitle) + reference + "）"
        );
      }
      lines.push("");
    }

    lines.push(
      "---",
      "",
      "來源 Session IDs：" + (report.sourceSessionIds.length ? report.sourceSessionIds.join(", ") : "無")
    );
    return lines.join("\n") + "\n";
  }
}
