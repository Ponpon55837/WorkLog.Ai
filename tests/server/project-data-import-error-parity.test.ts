import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectDataExport } from "@work-intelligence/core";
import {
  LATEST_SCHEMA_VERSION,
  MAX_IMPORT_ROW_BYTES,
  ProjectDataTransferError,
  WorkIntelligenceStore,
} from "../../packages/storage/src/index.js";
import { createApiHandler } from "../../apps/server/src/server.js";
import { RequestBodyError, validateProjectDataImportUpload } from "../../apps/server/src/http.js";

// Fictional data only. Before streaming, an import request body went through JSON.parse and then
// ValidatedProjectDataImport.validate (git e9ab744, parseProjectDataImportBytes). Each case is a broken request body;
// the expected status, API code and message are what that old path answered, derived by running it on the same text,
// and the streaming path must still answer them. Differences that are decisions, not accidents, are noted at their
// case or test.

interface Answer {
  status: number;
  code: string;
  message: string;
}

interface ParityCase {
  name: string;
  body: (bundle: ProjectDataExport) => string;
  /** What the old path answered. */
  expected: Answer | "accepted";
}

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const FORMAT_ERROR = "匯入檔格式錯誤：";

const roots: string[] = [];
const servers: Server[] = [];
const stores: WorkIntelligenceStore[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wi-import-parity-"));
  roots.push(root);
  return root;
}

function exportedBundle(): ProjectDataExport {
  const source = new WorkIntelligenceStore(":memory:");
  stores.push(source);
  const projectRoot = join(createRoot(), "project");
  mkdirSync(projectRoot);
  const project = source.addProject("Synthetic parity project", projectRoot);
  source.updateProject(project.id, { status: "tracked" });
  const result = source.finalizeSession({
    projectRoot,
    idempotencyKey: "parity-session",
    title: "Synthetic parity Session",
    summary: "Synthetic.",
    completedAt: "2026-04-01T00:00:00.000Z",
  });
  if (result.outcome !== "finalized") throw new Error("Expected a finalized Session.");
  return source.exportProjectData({ type: "all" });
}

function requestWith(bundle: ProjectDataExport, change: (copy: ProjectDataExport) => void, extra = {}): string {
  const copy = structuredClone(bundle);
  change(copy);
  return JSON.stringify({ bundle: copy, ...extra });
}

/** One table of the bundle replaced by raw JSON text for its value. */
function requestWithTable(bundle: ProjectDataExport, table: string, valueText: string): string {
  const tables = JSON.stringify({ ...bundle.tables, [table]: "@@" }).replace('"@@"', valueText);
  return requestWithTablesText(bundle, tables);
}

function requestWithTablesText(bundle: ProjectDataExport, tablesText: string): string {
  return `{"bundle":${JSON.stringify({ ...bundle, tables: "@@" }).replace('"@@"', tablesText)}}`;
}

function requestWithRaw(bundle: ProjectDataExport, change: (copy: ProjectDataExport) => void, raw: string): string {
  const copy = structuredClone(bundle);
  change(copy);
  return JSON.stringify({ bundle: copy }).replace('"@@"', raw);
}

function failure(error: unknown): Answer {
  if (error instanceof RequestBodyError) {
    return {
      status: error.statusCode,
      code: error.statusCode === 413 ? "payload_too_large" : "invalid_input",
      message: error.message,
    };
  }
  if (error instanceof ProjectDataTransferError) {
    return { status: 400, code: error.code, message: error.message };
  }
  throw error;
}

function streamedAnswer(body: string): Answer | "accepted" {
  const directory = mkdtempSync(join(createRoot(), "import-"));
  const path = join(directory, "import.json");
  writeFileSync(path, body);
  try {
    validateProjectDataImportUpload({ path, directory }).dispose();
    return "accepted";
  } catch (error) {
    return failure(error);
  }
}

async function listen(): Promise<string> {
  const store = new WorkIntelligenceStore(":memory:");
  stores.push(store);
  const server = createServer(createApiHandler(store, { transferRoot: join(createRoot(), "tmp") }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address.");
  return `http://127.0.0.1:${address.port}`;
}

const sessionRow = (copy: ProjectDataExport): Record<string, unknown> => copy.tables.sessions[0]!;
const valid = (bundle: ProjectDataExport): string => JSON.stringify({ bundle });
const withOption = (extra: Record<string, unknown>) => (bundle: ProjectDataExport) =>
  requestWith(bundle, () => undefined, extra);
const nested = (levels: number): string => `${"[".repeat(levels)}1${"]".repeat(levels)}`;
const setTitle = (copy: ProjectDataExport): void => void Object.assign(sessionRow(copy), { title: "@@" });
const setCount = (copy: ProjectDataExport): void => void Object.assign(sessionRow(copy), { redaction_count: "@@" });

const CASES: ParityCase[] = [
  { name: "valid file", body: valid, expected: "accepted" },
  {
    name: "whitespace only",
    body: () => " \n\t ",
    expected: { status: 400, code: "invalid_input", message: "Invalid JSON request body." },
  },
  {
    name: "truncated JSON",
    body: (bundle) => valid(bundle).slice(0, 300),
    expected: { status: 400, code: "invalid_input", message: "Invalid JSON request body." },
  },
  {
    name: "not JSON",
    body: () => "not json",
    expected: { status: 400, code: "invalid_input", message: "Invalid JSON request body." },
  },
  {
    name: "trailing garbage",
    body: (bundle) => `${valid(bundle)} x`,
    expected: { status: 400, code: "invalid_input", message: "Invalid JSON request body." },
  },
  {
    name: "two documents",
    body: (bundle) => `${valid(bundle)}${valid(bundle)}`,
    expected: { status: 400, code: "invalid_input", message: "Invalid JSON request body." },
  },
  {
    name: "NaN literal",
    body: (bundle) => requestWithRaw(bundle, setCount, "NaN"),
    expected: { status: 400, code: "invalid_input", message: "Invalid JSON request body." },
  },
  {
    name: "empty body",
    body: () => "",
    expected: {
      status: 400,
      code: "invalid_input",
      message: "匯入檔格式錯誤：Invalid input: expected object, received undefined",
    },
  },
  {
    name: "UTF-8 byte order mark",
    body: (bundle) => `${BYTE_ORDER_MARK}${valid(bundle)}`,
    expected: { status: 400, code: "invalid_input", message: "Invalid JSON request body." },
  },
  {
    name: "top level array",
    body: () => "[]",
    expected: {
      status: 400,
      code: "invalid_input",
      message: "匯入檔格式錯誤：Invalid input: expected object, received array",
    },
  },
  {
    name: "top level null",
    body: () => "null",
    expected: {
      status: 400,
      code: "invalid_input",
      message: "匯入檔格式錯誤：Invalid input: expected object, received null",
    },
  },
  {
    name: "top level string",
    body: () => '"text"',
    expected: {
      status: 400,
      code: "invalid_input",
      message: "匯入檔格式錯誤：Invalid input: expected object, received string",
    },
  },
  {
    name: "top level number",
    body: () => "42",
    expected: {
      status: 400,
      code: "invalid_input",
      message: "匯入檔格式錯誤：Invalid input: expected object, received number",
    },
  },
  {
    name: "empty object",
    body: () => "{}",
    expected: {
      status: 400,
      code: "invalid_input",
      message: "匯入檔格式錯誤：Invalid input: expected object, received undefined",
    },
  },
  {
    name: "unknown request key",
    body: withOption({ synthetic: true }),
    expected: {
      status: 400,
      code: "invalid_input",
      message: "匯入檔格式錯誤：Unknown field(s): synthetic. Unknown fields are rejected, not ignored.",
    },
  },
  {
    name: "wrong format",
    body: (bundle) => requestWith(bundle, (copy) => Object.assign(copy, { format: "other" })),
    expected: {
      status: 400,
      code: "invalid_input",
      message: '匯入檔格式錯誤：Invalid input: expected "work-intelligence-export"',
    },
  },
  {
    name: "wrong formatVersion",
    body: (bundle) => requestWith(bundle, (copy) => Object.assign(copy, { formatVersion: 99 })),
    expected: { status: 400, code: "invalid_input", message: "匯入檔格式錯誤：Invalid input: expected 1" },
  },
  {
    name: "missing tables",
    body: (bundle) => requestWith(bundle, (copy) => Reflect.deleteProperty(copy, "tables")),
    expected: {
      status: 400,
      code: "invalid_input",
      message: "匯入檔格式錯誤：Invalid input: expected object, received undefined",
    },
  },
  {
    name: "tables is an array",
    body: (bundle) => requestWithTablesText(bundle, "[]"),
    expected: {
      status: 400,
      code: "invalid_input",
      message: "匯入檔格式錯誤：Invalid input: expected object, received array",
    },
  },
  {
    name: "table is an object",
    body: (bundle) => requestWith(bundle, (copy) => Object.assign(copy.tables, { sessions: {} })),
    expected: {
      status: 400,
      code: "invalid_input",
      message: "匯入檔格式錯誤：Invalid input: expected array, received object",
    },
  },
  {
    name: "table is a string",
    body: (bundle) => requestWith(bundle, (copy) => Object.assign(copy.tables, { sessions: "rows" })),
    expected: {
      status: 400,
      code: "invalid_input",
      message: "匯入檔格式錯誤：Invalid input: expected array, received string",
    },
  },
  {
    name: "unknown table",
    body: (bundle) => requestWith(bundle, (copy) => Object.assign(copy.tables, { synthetic_table: [] })),
    expected: {
      status: 400,
      code: "invalid_input",
      message:
        "匯入檔格式錯誤：Unknown field(s) in bundle.tables: synthetic_table. Unknown fields are rejected, not ignored.",
    },
  },
  {
    name: "row is not an object",
    body: (bundle) => requestWithTable(bundle, "sessions", "[1]"),
    expected: {
      status: 400,
      code: "invalid_input",
      message: "匯入檔格式錯誤：Invalid input: expected record, received number",
    },
  },
  {
    name: "row is an array",
    body: (bundle) => requestWithTable(bundle, "sessions", "[[]]"),
    expected: {
      status: 400,
      code: "invalid_input",
      message: "匯入檔格式錯誤：Invalid input: expected record, received array",
    },
  },
  {
    name: "bad column name",
    body: (bundle) => requestWith(bundle, (copy) => Object.assign(sessionRow(copy), { "Bad-Column": "x" })),
    expected: { status: 400, code: "invalid_input", message: "匯入檔格式錯誤：Invalid key in record" },
  },
  {
    name: "unknown column",
    body: (bundle) => requestWith(bundle, (copy) => Object.assign(sessionRow(copy), { synthetic_extra: "x" })),
    expected: {
      status: 400,
      code: "invalid_input",
      message: "匯入檔格式錯誤：Each sessions row must contain exactly the supported columns.",
    },
  },
  {
    name: "missing required column",
    body: (bundle) => requestWith(bundle, (copy) => Reflect.deleteProperty(sessionRow(copy), "title")),
    expected: {
      status: 400,
      code: "invalid_input",
      message: "匯入檔格式錯誤：Each sessions row must contain exactly the supported columns.",
    },
  },
  {
    name: "object value in a row",
    body: (bundle) => requestWith(bundle, (copy) => Object.assign(sessionRow(copy), { title: { nested: 1 } })),
    expected: { status: 400, code: "invalid_input", message: "匯入檔格式錯誤：Invalid input" },
  },
  {
    name: "array value in a row",
    body: (bundle) => requestWith(bundle, (copy) => Object.assign(sessionRow(copy), { title: ["x"] })),
    expected: { status: 400, code: "invalid_input", message: "匯入檔格式錯誤：Invalid input" },
  },
  {
    name: "boolean value in a row",
    body: (bundle) => requestWith(bundle, (copy) => Object.assign(sessionRow(copy), { title: true })),
    expected: { status: 400, code: "invalid_input", message: "匯入檔格式錯誤：Invalid input" },
  },
  {
    name: "5,000-level nested array in a row",
    body: (bundle) => requestWithRaw(bundle, setTitle, nested(5_000)),
    expected: { status: 400, code: "invalid_input", message: "匯入檔格式錯誤：Invalid input" },
  },
  {
    name: "50,000-level nested array in a row",
    body: (bundle) => requestWithRaw(bundle, setTitle, nested(50_000)),
    expected: { status: 400, code: "invalid_input", message: "匯入檔格式錯誤：Invalid input" },
  },
  {
    name: "string of 2,000,001 characters",
    body: (bundle) =>
      requestWith(bundle, (copy) => Object.assign(sessionRow(copy), { summary: "x".repeat(2_000_001) })),
    expected: {
      status: 400,
      code: "invalid_input",
      message: "匯入檔格式錯誤：Too big: expected string to have <=2000000 characters",
    },
  },
  {
    name: "string of 2,000,000 characters",
    body: (bundle) =>
      requestWith(bundle, (copy) => Object.assign(sessionRow(copy), { summary: "x".repeat(2_000_000) })),
    expected: "accepted",
  },
  {
    name: "number beyond the double range",
    body: (bundle) => requestWithRaw(bundle, setCount, "1e999"),
    expected: { status: 400, code: "invalid_input", message: "匯入檔格式錯誤：Invalid input" },
  },
  {
    name: "project scope that is not in the file",
    body: (bundle) =>
      requestWith(bundle, (copy) => Object.assign(copy, { scope: { type: "project", projectId: "not-in-file" } })),
    expected: {
      status: 400,
      code: "invalid_input",
      message: "匯入檔格式錯誤：The selected project is missing from the export.",
    },
  },
  {
    name: "newer schema version",
    body: (bundle) => requestWith(bundle, (copy) => Object.assign(copy, { schemaVersion: LATEST_SCHEMA_VERSION + 1 })),
    expected: {
      status: 400,
      code: "unsupported_schema",
      message: "匯入檔使用較新的 schema 版本 34，此程式最高支援 33。請先更新 Work Intelligence 再匯入。",
    },
  },
  {
    name: "older schema version",
    body: (bundle) => requestWith(bundle, (copy) => Object.assign(copy, { schemaVersion: 30 })),
    expected: {
      status: 400,
      code: "unsupported_schema",
      message: "匯入檔使用 schema 版本 30，此程式可匯入 31 至 33 的匯出檔。",
    },
  },
  {
    name: "remap entry with a number",
    body: withOption({ remap: [{ from: 1, to: "/synthetic/b" }] }),
    expected: {
      status: 400,
      code: "invalid_input",
      message: "匯入檔格式錯誤：Invalid input: expected string, received number",
    },
  },
  {
    name: "remap that is not a list",
    body: withOption({ remap: "x" }),
    expected: {
      status: 400,
      code: "invalid_input",
      message: "匯入檔格式錯誤：Invalid input: expected array, received string",
    },
  },
  {
    name: "remap entry with a relative target",
    body: withOption({ remap: [{ from: "/synthetic/a", to: "relative" }] }),
    expected: {
      status: 400,
      code: "invalid_input",
      message: "匯入檔格式錯誤：The source and destination path prefixes must be absolute paths.",
    },
  },
  {
    name: "duplicate remap source",
    body: withOption({
      remap: [
        { from: "/synthetic/a", to: "/synthetic/b" },
        { from: "/synthetic/a/", to: "/synthetic/c" },
      ],
    }),
    expected: {
      status: 400,
      code: "invalid_input",
      message: "匯入檔格式錯誤：Each source path prefix can only be mapped once.",
    },
  },
  {
    name: "unknown strategy",
    body: withOption({ strategy: "overwrite-everything" }),
    expected: {
      status: 400,
      code: "invalid_input",
      message: '匯入檔格式錯誤：Invalid option: expected one of "merge"|"newer-wins"',
    },
  },
  {
    name: "projectId that is a number",
    body: withOption({ projectId: 5 }),
    expected: {
      status: 400,
      code: "invalid_input",
      message: "匯入檔格式錯誤：Invalid input: expected string, received number",
    },
  },
  {
    name: "200,000 empty rows in one table",
    body: (bundle) => requestWithTable(bundle, "work_events", `[${"{},".repeat(199_999)}{}]`),
    expected: {
      status: 400,
      code: "invalid_input",
      message: "匯入檔格式錯誤：Each work_events row must contain exactly the supported columns.",
    },
  },
  {
    name: "wrong format and a bad row at once",
    body: (bundle) =>
      requestWith(bundle, (copy) => {
        Object.assign(copy, { format: "other" });
        Object.assign(sessionRow(copy), { "Bad-Column": "x" });
      }),
    expected: {
      status: 400,
      code: "invalid_input",
      message: '匯入檔格式錯誤：Invalid input: expected "work-intelligence-export"',
    },
  },
  {
    name: "bad row in an early table and in a late table",
    body: (bundle) =>
      requestWith(bundle, (copy) => {
        Object.assign(copy.tables.projects[0]!, { status: "synthetic-status" });
        Object.assign(sessionRow(copy), { "Bad-Column": "x" });
      }),
    expected: { status: 400, code: "invalid_input", message: "匯入檔格式錯誤：Invalid key in record" },
  },
  {
    name: "duplicate bundle key, the last one is broken",
    body: (bundle) => `{"bundle":${JSON.stringify(bundle)},"bundle":{}}`,
    expected: {
      status: 400,
      code: "invalid_input",
      message: '匯入檔格式錯誤：Invalid input: expected "work-intelligence-export"',
    },
  },
  {
    name: "duplicate bundle key, the last one is valid",
    body: (bundle) => `{"bundle":{},"bundle":${JSON.stringify(bundle)}}`,
    expected: "accepted",
  },
];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function expectMatches(actual: Answer | "accepted", item: ParityCase): void {
  expect({ case: item.name, answer: actual }).toEqual({ case: item.name, answer: item.expected });
}

const OVER_ROW_LIMIT = (bundle: ProjectDataExport): string =>
  requestWithTable(bundle, "work_events", `[${"{},".repeat(200_000)}{}]`);

describe("project-data import error parity", () => {
  it("answers every broken file on a file as the whole-document path answered", () => {
    const bundle = exportedBundle();
    for (const item of CASES) expectMatches(streamedAnswer(item.body(bundle)), item);
  }, 120_000);

  it("answers the same through the REST route", async () => {
    const bundle = exportedBundle();
    const baseUrl = await listen();
    for (const item of CASES) {
      const response = await fetch(`${baseUrl}/api/import/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: item.body(bundle),
      });
      const body = (await response.json()) as { error?: string; code?: string; outcome?: string };
      const actual: Answer | "accepted" =
        response.status === 200
          ? "accepted"
          : { status: response.status, code: String(body.code), message: String(body.error) };
      if (item.expected === "accepted")
        expect({ case: item.name, status: response.status }).toEqual({ case: item.name, status: 200 });
      else expectMatches(actual, item);
    }
  }, 120_000);

  it("names the table when it has more than 200,000 rows, as a 400 invalid_input", async () => {
    // Intended change: the old path answered zod's "Too big: expected array to have <=200000 items" with no table.
    const bundle = exportedBundle();
    const streamed = streamedAnswer(OVER_ROW_LIMIT(bundle));
    const baseUrl = await listen();
    const response = await fetch(`${baseUrl}/api/import/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: OVER_ROW_LIMIT(bundle),
    });
    const body = (await response.json()) as { error: string; code: string };
    for (const answer of [streamed, { status: response.status, code: body.code, message: body.error }]) {
      expect(answer).toMatchObject({ status: 400, code: "invalid_input" });
      expect((answer as Answer).message.startsWith(FORMAT_ERROR)).toBe(true);
      expect((answer as Answer).message).toContain("work_events");
    }
  }, 60_000);

  it("refuses a single row beyond the row size limit with a 413, where the old path read the value and refused its length", () => {
    // Old answer: the 33 MiB string was parsed and failed the 2,000,000-character rule (400, invalid_input,
    // "Too big: expected string to have <=2000000 characters"); the stream refuses the row before parsing it.
    const bundle = exportedBundle();
    const body = requestWith(bundle, (copy) =>
      Object.assign(sessionRow(copy), { summary: "x".repeat(MAX_IMPORT_ROW_BYTES + 1) }),
    );
    expect(streamedAnswer(body)).toEqual({
      status: 413,
      code: "payload_too_large",
      message: "匯入檔中有單筆資料過大，無法匯入。",
    });
  }, 60_000);
});
