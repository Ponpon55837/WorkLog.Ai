/* global process */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

// Synthetic, in-memory research only. This is not a production candidate service.
const LIMIT = 5;
const PATH_LIMIT = 20;

function eligible(session) {
  return session.tracked && !session.voided && session.confirmed && session.paths.length <= PATH_LIMIT;
}

function compare(left, right) {
  return (
    right.shared.length - left.shared.length ||
    right.shared.length * left.union - left.shared.length * right.union ||
    right.completedAt - left.completedAt ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

function excludedIds(focus, links) {
  const ids = new Set([focus.id]);
  for (const [left, right] of links) {
    if (left === focus.id) ids.add(right);
    if (right === focus.id) ids.add(left);
  }
  return ids;
}

function buildIndex(sessions) {
  const postings = new Map();
  const records = new Map();
  for (const session of sessions) {
    if (!eligible(session)) continue;
    const paths = new Set(session.paths);
    records.set(session.id, { ...session, paths });
    for (const path of paths) {
      const key = JSON.stringify([session.project, path]);
      let bucket = postings.get(key);
      if (!bucket) {
        bucket = [];
        postings.set(key, bucket);
      }
      bucket.push(session.id);
    }
  }
  // Production SQL should supply this order through its query plan, not sort on every read.
  for (const bucket of postings.values()) {
    bucket.sort((a, b) => {
      const left = records.get(a);
      const right = records.get(b);
      return right.completedAt - left.completedAt || (a < b ? -1 : a > b ? 1 : 0);
    });
  }
  return { postings, records };
}

function queryIndex(index, focus, links = [], perPathLimit = Infinity) {
  if (!eligible(focus)) return { items: [], coverage: "unavailable", scannedPostings: 0, omittedPostings: 0 };
  const paths = new Set(focus.paths);
  const excluded = excludedIds(focus, links);
  const candidates = new Set();
  let scannedPostings = 0;
  let omittedPostings = 0;
  for (const path of paths) {
    const bucket = index.postings.get(JSON.stringify([focus.project, path])) ?? [];
    let read = 0;
    for (const id of bucket) {
      if (excluded.has(id)) continue;
      if (read >= perPathLimit) {
        omittedPostings += 1;
        continue;
      }
      read += 1;
      scannedPostings += 1;
      candidates.add(id);
    }
  }
  const items = [];
  for (const id of candidates) {
    const other = index.records.get(id);
    // Capped postings choose a pool; compute the real overlap for each admitted candidate.
    const shared = [...paths].filter((path) => other.paths.has(path)).sort();
    const row = { id, shared, union: paths.size + other.paths.size - shared.length, completedAt: other.completedAt };
    let position = 0;
    while (position < items.length && compare(items[position], row) <= 0) position += 1;
    if (position < LIMIT) {
      items.splice(position, 0, row);
      if (items.length > LIMIT) items.pop();
    }
  }
  return {
    items,
    coverage: omittedPostings ? "partial" : "complete",
    scannedPostings,
    omittedPostings,
  };
}

// Independent oracle: scans each record and sorts every result. It does not consume the index.
function scanOracle(sessions, focus, links = []) {
  if (!eligible(focus)) return [];
  const results = [];
  const excluded = new Set([focus.id]);
  for (const link of links) {
    if (link[0] === focus.id) excluded.add(link[1]);
    if (link[1] === focus.id) excluded.add(link[0]);
  }
  const focusPaths = [...new Set(focus.paths)];
  for (const session of sessions) {
    if (!eligible(session) || session.project !== focus.project || excluded.has(session.id)) continue;
    const otherPaths = [...new Set(session.paths)];
    const shared = focusPaths.filter((path) => otherPaths.includes(path)).sort();
    if (shared.length) {
      results.push({
        id: session.id,
        shared,
        union: new Set([...focusPaths, ...otherPaths]).size,
        completedAt: session.completedAt,
      });
    }
  }
  results.sort((left, right) => {
    if (left.shared.length !== right.shared.length) return right.shared.length - left.shared.length;
    const delta = right.shared.length / right.union - left.shared.length / left.union;
    if (delta) return delta;
    if (left.completedAt !== right.completedAt) return right.completedAt - left.completedAt;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return results.slice(0, LIMIT);
}

function session(id, paths, options = {}) {
  return {
    id,
    project: "fictional-alpha",
    paths,
    tracked: true,
    voided: false,
    confirmed: true,
    completedAt: 1,
    ...options,
  };
}

function measure(run, samples = 15) {
  for (let i = 0; i < 3; i += 1) run();
  const values = [];
  for (let i = 0; i < samples; i += 1) {
    const start = performance.now();
    run();
    values.push(performance.now() - start);
  }
  values.sort((a, b) => a - b);
  return { samples, medianMs: values[Math.floor(samples / 2)], p90Ms: values[Math.ceil(samples * 0.9) - 1] };
}

function runResearch() {
  const focus = session("focus", ["src/validator.ts", "src/routes.ts", "src/routes.ts"]);
  const cases = [
    focus,
    session("linked-forward", ["src/validator.ts", "src/routes.ts"]),
    session("linked-reverse", ["src/validator.ts"]),
    session("two-shared", ["src/validator.ts", "src/routes.ts"], { completedAt: 4 }),
    session("duplicate-path", ["src/validator.ts", "src/validator.ts"], { completedAt: 3 }),
    session("tie-a", ["src/routes.ts"], { completedAt: 2 }),
    session("tie-b", ["src/routes.ts"], { completedAt: 2 }),
    session("unrelated", ["src/else.ts"]),
    session("cross-project", ["src/validator.ts"], { project: "fictional-beta" }),
    session("voided", ["src/validator.ts"], { voided: true }),
    session("paused", ["src/validator.ts"], { tracked: false }),
    session("unconfirmed", ["src/validator.ts"], { confirmed: false }),
    session("oversized", ["src/validator.ts", ...Array.from({ length: 20 }, (_, i) => `bulk/${i}.ts`)]),
  ];
  const links = [
    ["focus", "linked-forward"],
    ["linked-reverse", "focus"],
  ];
  const index = buildIndex(cases);
  const actual = queryIndex(index, focus, links);
  assert.deepEqual(actual.items, scanOracle(cases, focus, links));
  assert.deepEqual(
    actual.items.map((row) => row.id),
    ["two-shared", "duplicate-path", "tie-a", "tie-b"],
  );
  assert.equal(actual.coverage, "complete");
  assert.equal(queryIndex(index, { ...focus, tracked: false }).coverage, "unavailable");
  assert.equal(queryIndex(index, { ...focus, confirmed: false }).coverage, "unavailable");
  assert.deepEqual(queryIndex(index, session("empty", [])).items, []);
  // Delimiter collisions must not join a different project/path tuple.
  const collisionFocus = session("tuple-left", ["b:c"], { project: "a" });
  const collisionOther = session("tuple-right", ["c"], { project: "a:b" });
  assert.deepEqual(queryIndex(buildIndex([collisionFocus, collisionOther]), collisionFocus).items, []);

  const sparse = Array.from({ length: 5000 }, (_, i) =>
    session(
      `s-${String(i).padStart(5, "0")}`,
      [`src/module-${i % 250}.ts`, `src/api-${i % 100}.ts`, `src/feature-${i % 1000}.ts`],
      { completedAt: i },
    ),
  );
  const sparseIndex = buildIndex(sparse);
  for (let i = 0; i < 64; i += 1) {
    assert.deepEqual(queryIndex(sparseIndex, sparse[i * 73]).items, scanOracle(sparse, sparse[i * 73]));
  }
  const dense = Array.from({ length: 5000 }, (_, i) =>
    session(`d-${String(i).padStart(5, "0")}`, ["shared/lockfile"], { completedAt: i }),
  );
  const denseIndex = buildIndex(dense);
  const denseFocus = session("dense-focus", ["shared/lockfile"]);
  assert.deepEqual(queryIndex(denseIndex, denseFocus).items, scanOracle(dense, denseFocus));
  const capped = queryIndex(denseIndex, denseFocus, [], 1000);
  assert.equal(capped.coverage, "partial");
  assert.equal(capped.scannedPostings, 1000);
  assert.equal(capped.omittedPostings, 4000);
  assert.equal(capped.items.length, LIMIT);

  return {
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, architecture: process.arch },
    scope: "Synthetic in-memory algorithm probe; no SQLite, API, production UI, or retrieval-quality claim.",
    correctness: {
      oracleQueriesPassed: 66,
      boundaryChecksPassed: 10,
      cases: [
        "duplicate paths",
        "bidirectional links",
        "same-project only",
        "voided/paused/unconfirmed/oversized",
        "empty",
        "ties",
        "tuple identity",
        "partial hot-path coverage",
      ],
    },
    benchmarks: {
      sessions: 5000,
      sparseIndexBuild: measure(() => buildIndex(sparse)),
      sparseScanQuery: measure(() => scanOracle(sparse, sparse[0])),
      sparsePrebuiltIndexQuery: measure(() => queryIndex(sparseIndex, sparse[0])),
      denseIndexBuild: measure(() => buildIndex(dense)),
      denseScanQuery: measure(() => scanOracle(dense, denseFocus)),
      densePrebuiltIndexQuery: measure(() => queryIndex(denseIndex, denseFocus)),
      denseCappedQuery: measure(() => queryIndex(denseIndex, denseFocus, [], 1000)),
    },
    cappedCoverage: {
      scannedPostings: capped.scannedPostings,
      omittedPostings: capped.omittedPostings,
      coverage: capped.coverage,
    },
    limitation:
      "This probe counts omitted postings by scanning the synthetic bucket; production must use bounded indexed SQL and separate count/coverage. Index build includes posting sort. A cap can miss the global best candidates.",
  };
}

const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 2 && args[0] === "--output"),
  "Usage: node related-work-candidates.mjs [--output new-file.json]",
);
const result = runResearch();
const content = JSON.stringify(result, null, 2) + "\n";
if (args[0] === "--output") writeFileSync(args[1], content, { flag: "wx" });
process.stdout.write(content);
