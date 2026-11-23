// Synthetic benchmark for the Agent usage scanner (packages/shared/src/agent-usage).
//
// Usage:
//   pnpm --filter @work-intelligence/shared build
//   node packages/shared/bench/agent-usage.bench.mjs [files=10000] [linesPerFile=100]
//
// Generates synthetic Claude Code session files (a few lines per file carry a large tool_result) into a temp
// directory, then measures a cold scan, a warm scan (every file cached) and a scan after appending to 1% of the files.
// The temp directory is deleted at the end; nothing real is read.
import console from "node:console";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const files = Number(process.argv[2] ?? 10_000);
const linesPerFile = Number(process.argv[3] ?? 100);
if (!Number.isInteger(files) || files < 1 || !Number.isInteger(linesPerFile) || linesPerFile < 4) {
  console.error("Usage: node agent-usage.bench.mjs [files>=1] [linesPerFile>=4]");
  process.exit(1);
}

const { summarizeFiles, UsageCache } = await import(
  pathToFileURL(join(import.meta.dirname, "..", "dist", "agent-usage", "index.js")).href
);

const BIG_RESULT = "r".repeat(200_000);
const SMALL_TEXT = "t".repeat(300);

function claudeLines(fileIndex, from, count) {
  const session = `bench-${fileIndex}`;
  const out = [];
  for (let line = from; line < from + count; line += 1) {
    const timestamp = new Date(Date.UTC(2026, 0, 1) + (fileIndex * 1000 + line) * 1000).toISOString();
    const id = `msg-${fileIndex}-${line}`;
    const toolId = `tool-${fileIndex}-${line}`;
    const kind = line % 4;
    if (kind === 0) {
      out.push({ type: "user", sessionId: session, timestamp, message: { role: "user", content: SMALL_TEXT } });
    } else if (kind === 1) {
      out.push({
        type: "assistant",
        sessionId: session,
        timestamp,
        message: {
          id,
          role: "assistant",
          content: [
            { type: "text", text: SMALL_TEXT },
            {
              type: "tool_use",
              id: toolId,
              name: "mcp__wi__work_read",
              input: { operation: "work_search_memory", query: SMALL_TEXT },
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 50,
            cache_read_input_tokens: 5000,
            cache_creation_input_tokens: 100,
          },
        },
      });
    } else if (kind === 2) {
      // A few results are very large (the long tail of real logs).
      const big = line % 50 === 2 && fileIndex % 5 === 0;
      out.push({
        type: "user",
        sessionId: session,
        timestamp,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: `tool-${fileIndex}-${line - 1}`,
              content: big ? BIG_RESULT : SMALL_TEXT,
            },
          ],
        },
      });
    } else {
      out.push({ type: "attachment", sessionId: session, timestamp, message: { content: SMALL_TEXT } });
    }
  }
  return out.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

async function measure(label, run) {
  globalThis.gc?.();
  const started = performance.now();
  const report = await run();
  const ms = performance.now() - started;
  const rssMb = process.memoryUsage().rss / 1024 / 1024;
  console.log(
    `${label.padEnd(26)} ${ms.toFixed(0).padStart(7)} ms   rss ${rssMb.toFixed(0).padStart(5)} MB   cache ${JSON.stringify(report.cache)}`,
  );
  return { ms, report };
}

const directory = mkdtempSync(join(tmpdir(), "agent-usage-bench-"));
try {
  const paths = [];
  let bytes = 0;
  for (let index = 0; index < files; index += 1) {
    const folder = join(directory, `project-${index % 50}`);
    if (index < 50) mkdirSync(folder, { recursive: true });
    const path = join(folder, `session-${index}.jsonl`);
    writeFileSync(path, claudeLines(index, 0, linesPerFile));
    bytes += statSync(path).size;
    paths.push(path);
  }
  console.log(`files=${files} linesPerFile=${linesPerFile} total=${(bytes / 1024 / 1024).toFixed(0)} MiB`);
  console.log(`start rss ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)} MB`);

  const cache = new UsageCache();
  const cold = await measure("cold scan", () => summarizeFiles([directory], { cache }));
  const warm = await measure("warm scan (all cached)", () => summarizeFiles([directory], { cache }));
  const touched = Math.max(1, Math.round(files / 100));
  for (let index = 0; index < touched; index += 1) {
    appendFileSync(paths[(index * 100) % files], claudeLines(index + files, 0, 8));
  }
  const appended = await measure(`scan after append (${touched})`, () => summarizeFiles([directory], { cache }));
  const uncached = await measure("scan without cache", () => summarizeFiles([directory]));

  const sameTotals = JSON.stringify(appended.report.total) === JSON.stringify(uncached.report.total);
  console.log(
    `warm/cold ${(warm.ms / cold.ms).toFixed(3)}  append/cold ${(appended.ms / cold.ms).toFixed(3)}  totals equal to a full rescan: ${sameTotals}`,
  );
  if (!sameTotals) process.exitCode = 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
