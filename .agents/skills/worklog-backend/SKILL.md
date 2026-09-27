---
name: worklog-backend
description: Conventions for the Work Intelligence backend — packages/storage (SQLite services, migrations, transactions, FTS search, performance), apps/server (REST routes, error codes, security), apps/mcp (tool definitions, annotations, Agent contracts), packages/schema (zod input validation), and the project-data rules every new table or column must follow (export/import, permanent deletion, search index). Use whenever writing or reviewing code under packages/ or apps/server or apps/mcp.
---

# Work Intelligence backend

These rules describe how the backend is already written and the mistakes that have already cost time. Follow them for new code and apply them in reviews. Web code has its own skills (`worklog-ui`, `worklog-web-code-style`); how Agents use the MCP tools is in `work-intelligence`.

## 1. Where code goes

```
packages/
  core/            domain types, const enums (PROJECT_DATA_TABLES, API_ERROR_CODES…); no I/O
  schema/          zod schemas for every external input (REST bodies, MCP args, import bundles)
  project-policy/  default-deny gate: which roots are tracked; path canonicalization
  shared/          time zone / calendar helpers, app version
  storage/src/
    store.ts             WorkIntelligenceStore: a thin facade that wires services and delegates
    *-service.ts         one domain each (knowledge, report, report-synthesis, metadata-backfill,
                         session-record, project-deletion, context-recall, project-data-transfer…)
    *-repository.ts      SQL for one table family; no policy decisions
    schema-migrations.ts append-only MIGRATIONS list; LATEST_SCHEMA_VERSION is derived from it
    search-repository.ts FTS5 index + ranking (work_recall / work_search)
apps/server/src/
  server.ts        REST routing, request parsing, error → status/code mapping
  cli.ts           pnpm db:* commands; doctor.ts is read-only diagnostics
apps/mcp/src/
  server.ts        tool definitions (StoreToolDefinition) and annotations
  contracts.ts     serverInstructions + per-tool contracts attached to writing tools
tests/<package>/   all tests live here, never beside src
```

- New domain logic goes in a service; `store.ts` only constructs services and forwards calls. Do not let `store.ts` grow again.
- Every external input is parsed with a schema from `packages/schema` before it reaches storage. Types come from the schema or core, not `as` casts.

## 2. Policy and privacy (non-negotiable)

- Default deny: every read or write that touches a project goes through the policy gate first (`checkProjectRoot` / `checkProjectById`). Untracked, paused, and ignored projects are skipped quietly, and their files, handoffs, and Git are never read.
- MCP never gets destructive powers over user data: no tool deletes projects, backups, or Sessions (void is reversible and already exists). Deletions happen only from the web UI or CLI with explicit confirmation.
- Never log or return content: errors and logs carry codes and counts, not Session text, paths from bundles, or SQLite messages. SSE events stay data-free (`changed`).
- Anything an Agent sends is untrusted input: validate size and shape, and never execute or render it unescaped.
- Paths from import bundles or Agents are never used to read or write files unless the user picked them in this session (the native folder picker) or they pass `project-policy` canonicalization.

## 3. Errors

- Storage throws typed errors with a `code` (for example `ProjectDeletionError`, `ProjectDataTransferError`, `DatabaseInitializationError`); detect SQLite busy with `isDatabaseBusyError`.
- The server maps codes to HTTP status and sends `{ error, code, details }` via `sendError`. Machine-readable codes are listed in `API_ERROR_CODES` (packages/core) and documented in `docs/rest-api.md`; adding one means updating both and the web mapping to Traditional Chinese.
- Unknown errors become a fixed 500 `internal_error` with no internal message. Check `response.headersSent` before writing any error response; after headers, destroy the connection.

## 4. SQLite

- Writes that must be atomic run inside `runImmediateTransaction(db, () => …)`. Re-check preconditions inside the transaction (the row may have changed since the pre-check).
- Schema changes are a new entry at the end of `MIGRATIONS` in `schema-migrations.ts` (never edit a shipped migration). Migrations run in one transaction after an automatic pre-migration backup. Add a test in `tests/storage/schema-migrations.test.ts` that upgrades from the previous version.
- Existing rows need a sensible value: give new columns a `DEFAULT` and backfill in the migration when the default is wrong for old data.

### Every new table or column is project data unless proven otherwise

`tests/storage/project-data-coverage.test.ts` fails until you decide:

- **New table holding project data** → add it to `PROJECT_DATA_TABLES` (core), `projectDataExportTableColumns` and required/numeric/status rules (schema), `TABLE_ORDER` and unique-field rules in `project-data-transfer.ts`, and delete its rows in `project-deletion-service.ts` inside the deletion transaction (including rows in other projects that point at the deleted one). Extend `tests/storage/project-deletion.test.ts` and the transfer round-trip test.
- **New table that is not project data** (index, audit, bookkeeping) → add it to `NOT_PROJECT_DATA` in that test with a reason.
- **New column on an exported table** → add it to `projectDataExportTableColumns`. If older export files will not have it, add a default to `projectDataColumnDefaults` so they stay importable, and test both formats (see the `changed_files_confirmed` test).
- If the data is searchable, mark the document dirty (`search_dirty`) on every write so the index stays in sync, and make sure deletion removes its search rows.

## 5. Performance rules (measured, not guessed)

- **Profile before optimizing.** Use `node --cpu-prof` or `inspector` on the synthetic 5,000-Session database from `packages/storage/bench/read-paths.bench.mjs`; check SQL with `EXPLAIN QUERY PLAN`.
- **FTS must drive the join.** Join `search_fts` to other tables with `CROSS JOIN` (`FROM search_fts CROSS JOIN search_chunks c ON c.id = search_fts.rowid`). With a plain `JOIN` and an indexed filter such as `doc_type IN (…)`, SQLite chose `search_chunks` as the outer loop and re-ran the full-text scan per chunk: 1,800 ms instead of 5 ms. Confirm the plan starts with `SCAN search_fts VIRTUAL TABLE`.
- **No per-row queries in loops (N+1).** When a list needs derived data, batch it: group by project, run one query per group, then compute in memory (see `KnowledgeService.withKnowledgeTrustMany`).
- **Do work once, not per pair.** Group with a `Map` in one pass instead of filtering the whole list per bucket (`buildReportTrends`); normalize each path once; compile globs/regexes once (`compileAppliesTo`); use binary search on sorted arrays (`firstSessionAfter`).
- **Every new read path gets a benchmark case and a p90 limit** in `read-paths.bench.mjs` (`pnpm test:performance`, runs in CI). Limits are loose enough for slow CI machines but must fail an order-of-magnitude regression. Document them in `docs/testing.md`.
- Changes to recall ranking must keep `pnpm test:retrieval-quality` (synthetic hit@5 / MRR gates) passing; add synthetic cases for new behavior, never real user data.

## 6. REST routes

- JSON bodies only for writes (`readJsonBody` requires `application/json`, which keeps cross-site forms out); destructive requests also require a JSON confirmation body.
- Host allowlist and Origin checks apply to every request; do not add routes that bypass `createApiHandler`.
- Document every route, body, and error code in `docs/rest-api.md`, and add server tests for success, validation failure, policy skip, and internal-error masking.

## 7. MCP tools

- Define tools with `StoreToolDefinition`: a zod `schema` (full validation) plus `inputShape` (advertised), an `invalidMessage`, and one of the annotation constants (`READ_ONLY`, `ADDITIVE_IDEMPOTENT`, `ADDITIVE`, `OVERWRITE_IDEMPOTENT`). Writing tools take an `idempotencyKey` so retries are safe.
- Descriptions say when to use the tool and what it will not do. Attach the governing contract from `contracts.ts` only to the tools that write that data; route natural-language requests in `serverInstructions`.
- Agent-produced content (reports, candidates, pages) follows the request → context → submit pattern and must cite `sourceSessionIds`; the user accepts it in the web UI when it becomes durable knowledge.
- Update `docs/mcp-tools.md` and `tests/mcp/server.test.ts`; remind the user that Agents must reconnect to see new tools.

## 8. Tests

- Fictional fixtures only; never real user data, paths, or the private evaluation questions.
- Use `new WorkIntelligenceStore(":memory:")` for logic, a temp directory for anything touching files or backups, and fake timers when ordering by time matters.
- Cover the boundary cases a batch or index can get wrong (several records with different start times, empty input, the first/last element).

## 9. Before opening a PR

Run, in order, and report each result: `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm test:coverage`, `pnpm test:performance`, `pnpm test:retrieval-quality`, `pnpm test:e2e`. Use pnpm, never npm/npx. Update `CHANGELOG.md`, the affected docs, and `docs/status.md`.
