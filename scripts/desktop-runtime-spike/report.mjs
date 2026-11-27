import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { ensureDirectory, formatBytes, platformTag, spikeDirectory } from "./common.mjs";

const ms = (value) => (value === undefined ? "n/a" : `${value.toFixed(0)} ms`);

export function writeReport(report) {
  const directory = ensureDirectory(spikeDirectory);
  const path = join(directory, `${platformTag}-${report.runtime.choice}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

export function appendStepSummary(report) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  const { sizes, timings, idle, sqlite } = report;
  const rows = [
    ["Runtime", `${report.runtime.kind} ${report.runtime.version} (${report.runtime.choice})`],
    ["SQLite / FTS5 / WAL-reset fix", `${sqlite.version} / ${sqlite.fts5} / ${sqlite.walResetFixed}`],
    ["Runtime directory", `${formatBytes(sizes.totalBytes)} in ${sizes.fileCount} files`],
    ["Compressed (tar.gz)", formatBytes(sizes.compressedBytes)],
    [
      "Executable / app bundle / Web / launcher",
      [sizes.executableBytes, sizes.bundleBytes, sizes.webBytes, sizes.launcherBytes].map(formatBytes).join(" / "),
    ],
    ["Verification, full SHA-256", ms(timings.verifyFullMs)],
    ["Verification, stat cache", ms(timings.verifyCachedMs)],
    [
      "Server start to /api/health, first / median of cached",
      `${ms(timings.serverFirstMs)} / ${ms(timings.serverMedianMs)}`,
    ],
    ["Server start, bundled executable without launcher", ms(timings.serverDirectMs)],
    ["MCP start to initialize, first / median of cached", `${ms(timings.mcpFirstMs)} / ${ms(timings.mcpMedianMs)}`],
    ["MCP start, bundled executable without launcher", ms(timings.mcpDirectMs)],
    ["Idle RSS: server / MCP", `${formatBytes(idle.serverRssBytes)} / ${formatBytes(idle.mcpRssBytes)}`],
    ["Idle CPU: server / MCP", `${idle.serverCpuPercent.toFixed(2)}% / ${idle.mcpCpuPercent.toFixed(2)}%`],
    ["Checks", `${report.passed} passed, ${report.failed} failed`],
  ];
  const failures = report.checks.filter((check) => !check.ok).map((check) => `- ${check.step}: ${check.detail}`);
  const lines = [
    `### Desktop runtime spike: ${platformTag}, ${report.runtime.choice}`,
    "",
    "| Metric | Value |",
    "| --- | --- |",
    ...rows.map(([name, value]) => `| ${name} | ${value} |`),
    "",
    ...(failures.length > 0 ? ["Failed checks:", ...failures, ""] : []),
  ];
  appendFileSync(target, `${lines.join("\n")}\n`);
}
