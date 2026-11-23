#!/usr/bin/env node
/**
 * Prints aggregate usage numbers from local Agent session logs. It never prints message text, tool inputs, file paths,
 * working directories, branch or project names, or error messages: only counts, token sums and timestamps.
 *
 * Usage: node scripts/agent-usage-report.mjs [--since <ISO>] [--until <ISO>] [--json] [--debug-shape] <file-or-directory>...
 *
 * This is a thin wrapper: the parsers, the deduplication rules (Claude Code and, EXPERIMENTALLY, Codex CLI rollouts),
 * the incremental cache and the formatting live in packages/shared/src/agent-usage (read its header comments for the
 * rules). It runs the built package, so run `pnpm --filter @work-intelligence/shared build` first.
 */
import console from "node:console";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  formatShapes,
  formatTable,
  summarizeFiles,
  summarizeShapes,
} from "../packages/shared/dist/agent-usage/index.js";

export { summarizeFiles, summarizeShapes };

const HELP = `Usage: node scripts/agent-usage-report.mjs [options] <file-or-directory>...

Prints aggregate usage (turns, tool calls, tokens, MCP result sizes) from local Claude Code session logs and,
experimentally, Codex CLI rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). The Codex parser is not verified
against real logs: run with --debug-shape to see the key names and types of your logs (never values), and compare one
session with the numbers Codex shows in /status before trusting the totals.
Directories are searched recursively for *.jsonl. Message text, tool inputs, paths and project names are never printed.

Options:
  --since <ISO>   only lines at or after this timestamp
  --until <ISO>   only lines at or before this timestamp
  --json          machine-readable output
  --debug-shape   print per line type the key paths and JS types (no values) instead of a report
  --help          show this help`;

function parseArgs(argv) {
  const options = { paths: [], json: false, help: false, debugShape: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--debug-shape") options.debugShape = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--since" || arg === "--until") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value.`);
      options[arg.slice(2)] = value;
      index += 1;
    } else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else options.paths.push(arg);
  }
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help || options.paths.length === 0) {
    console.log(HELP);
    return options.help ? 0 : 1;
  }
  if (options.debugShape) {
    console.log(formatShapes(await summarizeShapes(options.paths)));
    return 0;
  }
  const report = await summarizeFiles(options.paths, { since: options.since, until: options.until });
  console.log(options.json ? JSON.stringify(report, null, 2) : formatTable(report));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      // Only the error code/kind is printed: messages may embed file paths.
      console.error(`agent-usage-report failed${error?.code ? ` (${error.code})` : ""}.`);
      process.exitCode = 1;
    },
  );
}
