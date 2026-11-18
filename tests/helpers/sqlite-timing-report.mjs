/**
 * Prints the SQLite timing evidence of one CI job to stdout, so it can be read from the job log without downloading the
 * artifact: the ten slowest calls, and every BEGIN IMMEDIATE wait of 1 s or more with the transactions on the same
 * database file that overlapped it (the likely lock holders). Reads the JSONL files tests/helpers/sqlite-timing.ts wrote.
 *
 * Usage: node tests/helpers/sqlite-timing-report.mjs [directory] (default: perf-results). Test-only; changes no result,
 * and a missing or unreadable file prints a note and exits 0.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const TOP_SLOW = 10;
const LONG_WAIT_MS = 1000;
const MAX_HOLDERS = 3;
const SQL_LENGTH = 120;

function readRecords(directory) {
  let names;
  try {
    names = readdirSync(directory).filter((name) => /^sqlite-timing-.*\.jsonl$/.test(name));
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    let text;
    try {
      text = readFileSync(join(directory, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // A line cut by a killed process; the others still count.
      }
    }
  }
  return records;
}

function where(record) {
  const test = record.test ?? record.startTest ?? "-";
  return `file=${record.testFile ?? "-"} test=${JSON.stringify(test)} role=${record.role ?? "-"} pid=${record.pid ?? "-"}`;
}

function sql(record) {
  return JSON.stringify(String(record.sql ?? "").slice(0, SQL_LENGTH));
}

function overlap(left, right) {
  return Math.min(left.at + left.ms, right.at + right.ms) - Math.max(left.at, right.at);
}

export function sqliteTimingReport(records) {
  const lines = [];
  const slow = records.filter((record) => record.kind === "slow").sort((left, right) => right.ms - left.ms);
  lines.push(`[sqlite timing report] slow calls (>= 1 s): ${slow.length}; top ${Math.min(TOP_SLOW, slow.length)}:`);
  for (const record of slow.slice(0, TOP_SLOW)) {
    lines.push(`  ${record.ms} ms op=${record.op} db=${record.db ?? "-"} ${where(record)} sql=${sql(record)}`);
  }
  const transactions = records.filter((record) => record.kind === "transaction" && typeof record.at === "number");
  const waits = records
    .filter((record) => record.kind === "begin-immediate" && record.ms >= LONG_WAIT_MS)
    .sort((left, right) => right.ms - left.ms);
  lines.push(`[sqlite timing report] BEGIN IMMEDIATE waits (>= 1 s): ${waits.length}`);
  for (const wait of waits) {
    lines.push(`  ${wait.ms} ms db=${wait.db ?? "-"} failed=${Boolean(wait.failed)} ${where(wait)}`);
    const holders =
      typeof wait.at === "number" && wait.db
        ? transactions
            .filter((record) => record.db === wait.db && overlap(record, wait) > 0)
            .sort((left, right) => overlap(right, wait) - overlap(left, wait))
            .slice(0, MAX_HOLDERS)
        : [];
    if (holders.length === 0)
      lines.push("    holder: not inferred (no timed transaction on the same file overlapped it)");
    for (const holder of holders) {
      lines.push(`    holder? ${holder.ms} ms transaction overlapping ${overlap(holder, wait)} ms ${where(holder)}`);
    }
  }
  return lines;
}

if (process.argv[1]?.endsWith("sqlite-timing-report.mjs")) {
  const directory = process.argv[2] ?? "perf-results";
  const records = readRecords(directory);
  const lines =
    records.length === 0 ? [`[sqlite timing report] no records in ${directory}`] : sqliteTimingReport(records);
  process.stdout.write(`${lines.join("\n")}\n`);
}
