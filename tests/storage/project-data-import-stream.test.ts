import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectDataExport } from "../../packages/core/src/index.js";
import {
  MAX_IMPORT_ROW_BYTES,
  ProjectDataImportSyntaxError,
  ProjectDataTransferError,
  ValidatedProjectDataImport,
  WorkIntelligenceStore,
  readProjectDataImportBytes,
  readProjectDataImportFile,
  type ProjectDataImportEnvelope,
} from "../../packages/storage/src/index.js";

// Fictional data only. The reader scans bytes in 1 MiB chunks, so a token that straddles a chunk boundary is the
// risky case. The API only takes whole buffers and files, so each case is shifted by leading whitespace until the
// 1 MiB boundary falls on every byte of the token in turn. Every read must give what the whole-document path
// (JSON.parse, then ValidatedProjectDataImport.validate) gives: the same source digest for a valid file, the same
// error for an invalid one.

type Outcome = { ok: true; digest: string; redactions: number } | { ok: false; kind: string; message?: string };

const CHUNK = 1024 * 1024;
const roots: string[] = [];
const stores: WorkIntelligenceStore[] = [];
let spillCounter = 0;

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wi-import-stream-"));
  roots.push(root);
  return root;
}

function exportedBundle(): ProjectDataExport {
  const source = new WorkIntelligenceStore(":memory:");
  stores.push(source);
  const projectRoot = join(createRoot(), "project");
  mkdirSync(projectRoot);
  const project = source.addProject("Synthetic stream project", projectRoot);
  source.updateProject(project.id, { status: "tracked" });
  const result = source.finalizeSession({
    projectRoot,
    idempotencyKey: "stream-session",
    title: "Synthetic stream Session",
    summary: "Synthetic.",
    completedAt: "2026-04-01T00:00:00.000Z",
  });
  if (result.outcome !== "finalized") throw new Error("Expected a finalized Session.");
  return source.exportProjectData({ type: "all" });
}

/** A request body whose first Session has `title` set to the raw JSON text `raw`, and `change` applied first. */
function requestWithTitle(
  bundle: ProjectDataExport,
  raw: string,
  change?: (row: Record<string, unknown>) => void,
): string {
  const copy = structuredClone(bundle);
  const row = copy.tables.sessions[0] as Record<string, unknown>;
  row.title = "@@";
  change?.(row);
  return JSON.stringify({ bundle: copy }).replace('"@@"', raw);
}

function outcomeOfError(error: unknown): Outcome {
  if (error instanceof ProjectDataImportSyntaxError) return { ok: false, kind: error.kind };
  if (error instanceof ProjectDataTransferError) return { ok: false, kind: error.code, message: error.message };
  throw error;
}

function summarize(validated: ValidatedProjectDataImport): Outcome {
  try {
    return { ok: true, digest: validated.sourceDigest(), redactions: validated.redactions.total };
  } finally {
    validated.dispose();
  }
}

/** The whole-document path of the old import: JSON.parse, then validate. */
function wholeDocument(text: string, envelope: ProjectDataImportEnvelope): Outcome {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, kind: "invalid_json" };
  }
  try {
    return summarize(ValidatedProjectDataImport.validate(envelope === "bundle" ? { bundle: value } : value));
  } catch (error) {
    return outcomeOfError(error);
  }
}

function spillPath(): string {
  spillCounter += 1;
  return join(createRoot(), `import-${spillCounter}.spill`);
}

function streamed(bytes: Uint8Array, envelope: ProjectDataImportEnvelope): Outcome {
  try {
    return summarize(readProjectDataImportBytes(bytes, { envelope, spillPath: spillPath() }));
  } catch (error) {
    return outcomeOfError(error);
  }
}

/** The text with `pad` spaces in front, so everything in it moves `pad` bytes towards the end of the first chunk. */
function shifted(text: string, pad: number): Buffer {
  return Buffer.concat([Buffer.alloc(pad, 0x20), Buffer.from(text)]);
}

/** Reads `text` whole, and once per shift that puts the 1 MiB chunk boundary on each byte of `marker`. */
function expectSameAtEveryBoundary(
  text: string,
  marker: string,
  envelope: ProjectDataImportEnvelope = "request",
): void {
  const expected = wholeDocument(text, envelope);
  expect(streamed(Buffer.from(text), envelope)).toEqual(expected);
  const bytes = Buffer.from(text);
  const offset = bytes.indexOf(marker);
  expect(offset).toBeGreaterThanOrEqual(0);
  const length = Buffer.byteLength(marker);
  for (let inside = -1; inside <= length; inside += 1) {
    const pad = CHUNK - offset - inside;
    if (pad < 0) continue;
    expect({ marker, inside, outcome: streamed(shifted(text, pad), envelope) }).toEqual({
      marker,
      inside,
      outcome: expected,
    });
  }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("streaming import reader, chunk boundaries", () => {
  it("reads a valid file the way the whole-document path does", () => {
    const text = JSON.stringify({ bundle: exportedBundle() });
    const expected = wholeDocument(text, "request");
    expect(expected.ok).toBe(true);
    expect(streamed(Buffer.from(text), "request")).toEqual(expected);
  });

  it.each([
    ["an escaped quote", '"before \\" after"'],
    ["an escaped backslash before the closing quote", '"ends with a backslash \\\\"'],
    ["three backslashes and a quote", '"odd \\\\\\" run"'],
    ["a slash, a newline and a tab escape", '"a\\/b\\nc\\td"'],
    ["a unicode escape", '"caf\\u00e9 \\u4e2d\\u6587"'],
    ["an escaped surrogate pair", '"pair \\ud83d\\ude00 end"'],
    ["a lone escaped surrogate", '"lone \\ud83d end"'],
    ["multi-byte UTF-8 text", '"café 中文 😀 end"'],
    ["a string of only multi-byte characters", '"中中中中中中"'],
  ])("splits %s at every byte", (_name, raw) => {
    expectSameAtEveryBoundary(requestWithTitle(exportedBundle(), raw), raw);
  });

  it("splits a key, a colon and a comma at every byte", () => {
    const text = requestWithTitle(exportedBundle(), '"plain"');
    expectSameAtEveryBoundary(text, '"title":"plain",');
    expectSameAtEveryBoundary(text, '{"bundle":{"format"');
  });

  it("splits the end of the document at every byte", () => {
    const text = JSON.stringify({ bundle: exportedBundle() });
    expectSameAtEveryBoundary(text, text.slice(-12));
  });

  it("splits a number in exponent form at every byte", () => {
    for (const number of ["1e2", "1E+2", "1e-0", "-0", "0.5e1", "12345678901234567890"]) {
      const text = requestWithTitle(exportedBundle(), '"n"', (row) => {
        row.redaction_count = "@@@";
      }).replace('"@@@"', number);
      expectSameAtEveryBoundary(text, number);
    }
  });

  it("splits a bare bundle (the CLI envelope) at every byte of its first tokens", () => {
    const text = JSON.stringify(exportedBundle());
    expectSameAtEveryBoundary(text, '{"format":"work', "bundle");
  });
});

/** The reader fed `chunkBytes` at a time; 1 puts a chunk boundary on every offset of the input at once. */
function streamedInChunks(
  input: string | Uint8Array,
  envelope: ProjectDataImportEnvelope,
  chunkBytes: number,
): Outcome {
  const bytes = typeof input === "string" ? Buffer.from(input) : input;
  try {
    return summarize(readProjectDataImportBytes(bytes, { envelope, spillPath: spillPath() }, chunkBytes));
  } catch (error) {
    return outcomeOfError(error);
  }
}

/** The same outcome as the whole-document path with a chunk boundary at every offset, and with a few other sizes. */
function expectSameAtEveryOffset(text: string, envelope: ProjectDataImportEnvelope = "request"): Outcome {
  const expected = wholeDocument(text, envelope);
  for (const chunkBytes of [1, 2, 3, 5, 7, 64]) {
    expect({ chunkBytes, outcome: streamedInChunks(text, envelope, chunkBytes) }).toEqual({
      chunkBytes,
      outcome: expected,
    });
  }
  return expected;
}

describe("streaming import reader, every split of a small envelope", () => {
  it("reads every envelope value type the same wherever a chunk ends", () => {
    const bundle = exportedBundle();
    const bare = JSON.stringify(bundle);
    expect(expectSameAtEveryOffset(bare, "bundle").ok).toBe(true);
    expect(expectSameAtEveryOffset(JSON.stringify({ bundle }), "request").ok).toBe(true);
    // Numbers, null, true and false outside the rows, each before a comma, a brace and a bracket; the schema answers
    // for the ones it refuses, and must answer the same.
    const { formatVersion, ...rest } = bundle;
    const values = ["1", "27", "-1.5e3", "0", "null", "true", "false"];
    for (const value of values) {
      expectSameAtEveryOffset(`{"formatVersion":${value},${JSON.stringify(rest).slice(1)}`, "bundle");
      expectSameAtEveryOffset(`{"bundle":${bare},"projectId":${value}}`, "request");
      expectSameAtEveryOffset(`{"bundle":${bare},"remap":[${value}]}`, "request");
    }
    expect(formatVersion).toBe(1);
  });

  it("reads a literal at the very end of the input the same, split at every offset", () => {
    for (const text of ["1", "27", "null", "true", "false", '"text"', "[]", "{}"]) expectSameAtEveryOffset(text);
  });

  it("refuses a bracket closed by the other kind, inside a row or outside, as invalid JSON", () => {
    const bundle = exportedBundle();
    for (const raw of ['{"a":[}', '{"a":[1}', '[{"a":1]', '{"a":{"b":[]}]']) {
      const text = requestWithTitle(bundle, raw);
      expect(expectSameAtEveryOffset(text)).toEqual({ ok: false, kind: "invalid_json" });
    }
    const outside = JSON.stringify({ bundle }).replace('"projectId"', '"projectId"').replace(/}$/, ',"remap":[}}');
    expect(expectSameAtEveryOffset(outside)).toEqual({ ok: false, kind: "invalid_json" });
  });

  it("counts masked secrets only in the rows the import keeps", () => {
    const bundle = exportedBundle();
    const secret = structuredClone(bundle.tables.sessions[0] as Record<string, unknown>);
    secret.summary = `token ghp_${"S".repeat(36)} and ghp_${"T".repeat(36)} and ghp_${"U".repeat(36)}`;
    const sessions = JSON.stringify(bundle.tables.sessions);
    const tables = JSON.stringify(bundle.tables).slice(1);
    const { tables: _tables, ...meta } = bundle;
    const metaText = JSON.stringify(meta).slice(0, -1);
    const repeatedTable = `{"bundle":${metaText},"tables":{"sessions":${JSON.stringify([secret])},${tables}}}`;
    const replacedTable = `{"bundle":${metaText},"tables":{"sessions":${JSON.stringify([secret])},"sessions":${sessions},${tables.slice(0, -1)}}}}`;
    const replacedByScalar = `{"bundle":${metaText},"tables":{"sessions":${JSON.stringify([secret])},"sessions":3,${tables}}}`;
    const replacedTables = `{"bundle":${metaText},"tables":{"sessions":${JSON.stringify([secret])}},"tables":{${tables}}}`;
    const replacedBundle = `{"bundle":{"tables":{"sessions":${JSON.stringify([secret])}}},"bundle":${JSON.stringify(bundle)}}`;
    for (const text of [replacedTables, replacedBundle]) {
      const expected = expectSameAtEveryOffset(text);
      expect(expected).toMatchObject({ ok: true, redactions: 0 });
    }
    // The kept table is the secret one here: its three tokens are counted once.
    expect(wholeDocument(repeatedTable, "request")).toMatchObject({ ok: true });
    for (const text of [replacedTable, replacedByScalar]) {
      expect(streamedInChunks(text, "request", 64)).toEqual(wholeDocument(text, "request"));
    }
  });
});

describe("streaming import reader, document shape", () => {
  it("accepts leading and trailing whitespace", () => {
    const text = JSON.stringify({ bundle: exportedBundle() });
    const expected = wholeDocument(text, "request");
    expect(expected.ok).toBe(true);
    for (const padded of [` \n\t\r${text}`, `${text}\n\n \t`, `\n  ${text}  \r\n`]) {
      expect(streamed(Buffer.from(padded), "request")).toEqual(expected);
    }
  });

  it("accepts whitespace between every token", () => {
    const bundle = exportedBundle();
    const text = JSON.stringify({ bundle }, null, 2);
    expect(streamed(Buffer.from(text), "request")).toEqual(wholeDocument(text, "request"));
    expect(streamed(Buffer.from(text), "request").ok).toBe(true);
  });

  it("skips a leading UTF-8 byte order mark, as the 1.6.46 page did by reading the file as text", () => {
    const text = JSON.stringify({ bundle: exportedBundle() });
    const expected = streamed(Buffer.from(text), "request");
    expect(expected.ok).toBe(true);
    const withMark = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]);
    expect(streamed(withMark, "request")).toEqual(expected);
  });

  it("skips the byte order mark when a chunk boundary cuts it in two", () => {
    const text = JSON.stringify({ bundle: exportedBundle() });
    const expected = streamed(Buffer.from(text), "request");
    const withMark = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]);
    for (const chunkBytes of [1, 2, 3]) {
      expect(streamedInChunks(withMark, "request", chunkBytes)).toEqual(expected);
    }
  });

  it("still refuses a body that is only a byte order mark, a broken one and a second one", () => {
    for (const bytes of [
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from([0xef, 0xbb]),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0x20]), Buffer.from("{}")]),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), Buffer.from("{}")]),
    ]) {
      expect(streamed(bytes, "request")).toEqual({ ok: false, kind: "invalid_json" });
    }
  });

  it.each([
    ["a second document", (text: string) => `${text}${text}`],
    ["a stray word", (text: string) => `${text} x`],
    ["an extra closing brace", (text: string) => `${text}}`],
    ["a comma", (text: string) => `${text},`],
    ["a number", (text: string) => `${text} 1`],
    ["an empty object", (text: string) => `${text}{}`],
    ["a NUL byte", (text: string) => `${text}\0`],
  ])("refuses %s after the top-level value", (_name, change) => {
    const text = change(JSON.stringify({ bundle: exportedBundle() }));
    expect(wholeDocument(text, "request")).toEqual({ ok: false, kind: "invalid_json" });
    expect(streamed(Buffer.from(text), "request")).toEqual({ ok: false, kind: "invalid_json" });
  });

  it("refuses trailing garbage that starts in the next chunk", () => {
    const text = JSON.stringify({ bundle: exportedBundle() });
    const bytes = Buffer.concat([Buffer.from(text), Buffer.alloc(CHUNK, 0x20), Buffer.from("x")]);
    expect(streamed(bytes, "request")).toEqual({ ok: false, kind: "invalid_json" });
  });

  it("refuses every truncation of a document as invalid JSON", () => {
    const text = JSON.stringify({ bundle: exportedBundle() });
    const bytes = Buffer.from(text);
    const cuts = new Set<number>([1, 2, 5, 9, 10, 11, bytes.byteLength - 1, bytes.byteLength - 2]);
    for (let cut = 1; cut < bytes.byteLength; cut += 97) cuts.add(cut);
    for (const cut of cuts) {
      expect({ cut, outcome: streamed(bytes.subarray(0, cut), "request") }).toEqual({
        cut,
        outcome: { ok: false, kind: "invalid_json" },
      });
    }
  });

  it("refuses a truncation that ends inside a multi-byte character", () => {
    const text = requestWithTitle(exportedBundle(), '"中文"');
    const bytes = Buffer.from(text);
    const inside = bytes.indexOf("中") + 1;
    expect(streamed(bytes.subarray(0, inside), "request")).toEqual({ ok: false, kind: "invalid_json" });
  });

  it.each([
    ["an array", "[]"],
    ["a string", '"text"'],
    ["a number", "42"],
    ["null", "null"],
    ["true", "true"],
    ["an empty object", "{}"],
    ["an array of bundles", "[{}]"],
  ])("answers %s at the top level as the whole-document path does", (_name, text) => {
    for (const envelope of ["request", "bundle"] as const) {
      const expected = wholeDocument(text, envelope);
      expect(expected.ok).toBe(false);
      expect(streamed(Buffer.from(text), envelope)).toEqual(expected);
    }
  });

  it("refuses malformed structure the way JSON.parse does", () => {
    for (const text of [
      "{",
      "}",
      '{"bundle"}',
      '{"bundle":}',
      '{"bundle":{},}',
      '{,"bundle":{}}',
      "{bundle:{}}",
      "{'bundle':{}}",
      '{"bundle":{"tables":{"sessions":[,]}}}',
      '{"bundle":{"tables":{"sessions":[{},,{}]}}}',
      '{"bundle":{"tables":{"sessions":[{}' + "}}}",
      '{"bundle":{"tables":{"sessions":[01]}}}',
      '{"bundle":{"tables":{"sessions":[{"a":"\\x"}]}}}',
      '{"bundle":{"tables":{"sessions":[{"a":"line\nbreak"}]}}}',
      '{"bundle":{"tables":{"sessions":[{"a":tru}]}}}',
      '{"bundle":{"tables":{"sessions":[{"a":+1}]}}}',
    ]) {
      expect({ text, outcome: streamed(Buffer.from(text), "request") }).toEqual({
        text,
        outcome: wholeDocument(text, "request"),
      });
    }
  });
});

describe("streaming import reader, values", () => {
  it("takes the last of duplicate keys, as JSON.parse does", () => {
    const bundle = exportedBundle();
    const good = JSON.stringify(bundle);
    const broken = JSON.stringify({ ...bundle, format: "other" });
    const texts = [
      `{"bundle":${broken},"bundle":${good}}`,
      `{"bundle":${good},"bundle":${broken}}`,
      `{"bundle":${good},"strategy":"merge","strategy":"newer-wins"}`,
      `{"bundle":${good},"strategy":"newer-wins","strategy":"other"}`,
      `{"bundle":${JSON.stringify({ ...bundle, tables: undefined }).slice(0, -1)},"tables":${JSON.stringify(bundle.tables)},"tables":{}}}}`,
    ];
    for (const text of texts) {
      expect({ text: text.slice(0, 60), outcome: streamed(Buffer.from(text), "request") }).toEqual({
        text: text.slice(0, 60),
        outcome: wholeDocument(text, "request"),
      });
    }
  });

  it("takes the last duplicate key inside a row and the last duplicate table", () => {
    const bundle = exportedBundle();
    const titleTwice = requestWithTitle(bundle, '"first","title":"second"');
    expect(streamed(Buffer.from(titleTwice), "request")).toEqual(wholeDocument(titleTwice, "request"));
    expect(wholeDocument(titleTwice, "request").ok).toBe(true);
    // A bad first table and a good second one: the second replaces the first.
    const tables = JSON.stringify(bundle.tables);
    const twice = JSON.stringify({ bundle: { ...bundle, tables: "@@" } }).replace(
      '"@@"',
      `${tables.slice(0, -1)},"sessions":[1]}`,
    );
    const lastBad = twice.replace(/"sessions":\[1\]/, '"sessions":[]');
    for (const text of [twice, lastBad]) {
      expect(streamed(Buffer.from(text), "request")).toEqual(wholeDocument(text, "request"));
    }
  });

  it("reads numbers in exponent form as JSON.parse does", () => {
    const bundle = exportedBundle();
    for (const number of ["1e2", "1E+2", "1e-0", "-0", "0.5e1", "1e999", "-1e999", "1e-999", "12345678901234567890"]) {
      const text = JSON.stringify({ bundle: { ...bundle, tables: { ...bundle.tables, sessions: "@@" } } }).replace(
        '"@@"',
        JSON.stringify([{ ...(bundle.tables.sessions[0] as object), redaction_count: "@@@" }]).replace('"@@@"', number),
      );
      expect({ number, outcome: streamed(Buffer.from(text), "request") }).toEqual({
        number,
        outcome: wholeDocument(text, "request"),
      });
    }
  });

  it("refuses an object or array inside a row like the whole-document path, however deep", () => {
    const bundle = exportedBundle();
    for (const raw of [
      "[]",
      "{}",
      '{"a":[1,{"b":"]"}]}',
      '["}", "{"]',
      `${"[".repeat(50)}1${"]".repeat(50)}`,
      `${"[".repeat(100_000)}1${"]".repeat(100_000)}`,
      `${'{"a":'.repeat(20_000)}1${"}".repeat(20_000)}`,
    ]) {
      const text = requestWithTitle(bundle, raw);
      const expected = wholeDocument(text, "request");
      expect(expected.ok).toBe(false);
      expect({ raw: raw.slice(0, 20), outcome: streamed(Buffer.from(text), "request") }).toEqual({
        raw: raw.slice(0, 20),
        outcome: expected,
      });
    }
  });

  it("keeps brackets and quotes inside strings of a row from ending it", () => {
    const text = requestWithTitle(exportedBundle(), JSON.stringify('[{"}]]" \\ ]}{'));
    expect(wholeDocument(text, "request").ok).toBe(true);
    expect(streamed(Buffer.from(text), "request")).toEqual(wholeDocument(text, "request"));
  });

  it("reads a long value (a megabyte of text) that spans several chunks", () => {
    const text = requestWithTitle(exportedBundle(), JSON.stringify('中é\\"x'.repeat(300_000).slice(0, 1_999_000)));
    expect(streamed(Buffer.from(text), "request")).toEqual(wholeDocument(text, "request"));
    expect(wholeDocument(text, "request").ok).toBe(true);
  });
});

describe("streaming import reader, row size", () => {
  it("refuses a row over MAX_IMPORT_ROW_BYTES with the row_too_large kind", () => {
    const text = requestWithTitle(exportedBundle(), JSON.stringify("x".repeat(MAX_IMPORT_ROW_BYTES + 1)));
    expect(streamed(Buffer.from(text), "request")).toEqual({ ok: false, kind: "row_too_large" });
    expect(streamed(Buffer.from(text), "request")).not.toEqual({ ok: false, kind: "invalid_json" });
  });

  it("refuses a row over the limit that is made of nested values, before building them", () => {
    const text = requestWithTitle(exportedBundle(), `[${"0,".repeat(MAX_IMPORT_ROW_BYTES / 2)}0]`);
    expect(streamed(Buffer.from(text), "request")).toEqual({ ok: false, kind: "row_too_large" });
  });

  it("reports an oversized row as such even when the file ends inside it", () => {
    const prefix = requestWithTitle(exportedBundle(), '"@@@"').split('"@@@"')[0] as string;
    const bytes = Buffer.concat([Buffer.from(`${prefix}"`), Buffer.alloc(MAX_IMPORT_ROW_BYTES + 1, 0x78)]);
    expect(streamed(bytes, "request")).toEqual({ ok: false, kind: "row_too_large" });
  });

  it("does not count the other rows towards one row's limit", () => {
    const bundle = exportedBundle();
    const row = JSON.stringify({ ...(bundle.tables.sessions[0] as object), summary: "x".repeat(1_900_000) });
    expect(Buffer.byteLength(row)).toBeLessThan(MAX_IMPORT_ROW_BYTES);
    const text = JSON.stringify({ bundle: { ...bundle, tables: { ...bundle.tables, sessions: "@@" } } }).replace(
      '"@@"',
      `[${row}]`,
    );
    expect(streamed(Buffer.from(text), "request")).toEqual(wholeDocument(text, "request"));
  });
});

describe("streaming import reader, scan cost", () => {
  it("looks for a closing quote only in the bytes it holds, not in what a larger earlier row left behind", () => {
    const bundle = exportedBundle();
    const big = structuredClone(bundle.tables.sessions[0] as Record<string, unknown>);
    big.id = "synthetic-big-session";
    big.summary = "a".repeat(1_900_000);
    bundle.tables.sessions.unshift(big as never);
    const text = JSON.stringify({ bundle });
    let scanned = 0;
    const original = Uint8Array.prototype.indexOf;
    const spy = vi.spyOn(Uint8Array.prototype, "indexOf").mockImplementation(function (
      this: Uint8Array,
      value: number,
      from?: number,
    ) {
      const found = original.call(this, value, from);
      scanned += (found === -1 ? this.length : found) - (from ?? 0);
      return found;
    });
    try {
      streamedInChunks(text, "request", 4096);
    } finally {
      spy.mockRestore();
    }
    // Each byte is searched about once; rescanning the 2 MiB left behind by the big row at every later chunk boundary
    // inside a string would cost orders of magnitude more.
    expect(scanned).toBeLessThan(2 * Buffer.byteLength(text));
  });
});

describe("streaming import reader, spill file", () => {
  it("creates the spill file with the read and removes it on dispose, twice safely", () => {
    const text = JSON.stringify({ bundle: exportedBundle() });
    const spill = spillPath();
    const validated = readProjectDataImportBytes(Buffer.from(text), { envelope: "request", spillPath: spill });
    expect(existsSync(spill)).toBe(true);
    validated.dispose();
    expect(existsSync(spill)).toBe(false);
    validated.dispose();
    expect(existsSync(spill)).toBe(false);
  });

  it("removes the spill file when the file is refused", () => {
    const text = JSON.stringify({ bundle: exportedBundle() });
    const cases = [`${text} x`, text.slice(0, 200), requestWithTitle(exportedBundle(), "[1]"), "[]"];
    for (const body of cases) {
      const spill = spillPath();
      expect(() => readProjectDataImportBytes(Buffer.from(body), { envelope: "request", spillPath: spill })).toThrow();
      expect({ body: body.slice(0, 30), spill: existsSync(spill) }).toEqual({ body: body.slice(0, 30), spill: false });
    }
  });

  it("removes the spill file when a row is too large", () => {
    const text = requestWithTitle(exportedBundle(), JSON.stringify("x".repeat(MAX_IMPORT_ROW_BYTES + 1)));
    const spill = spillPath();
    expect(() => readProjectDataImportBytes(Buffer.from(text), { envelope: "request", spillPath: spill })).toThrow(
      ProjectDataImportSyntaxError,
    );
    expect(existsSync(spill)).toBe(false);
  });

  it("reads a file the same as the bytes and removes the spill file on dispose and on failure", () => {
    const directory = createRoot();
    const text = JSON.stringify({ bundle: exportedBundle() });
    const path = join(directory, "good.json");
    const bad = join(directory, "bad.json");
    writeFileSync(path, text);
    writeFileSync(bad, `${text} x`);
    const spill = join(directory, "file.spill");
    const validated = readProjectDataImportFile(path, { envelope: "request", spillPath: spill });
    expect(existsSync(spill)).toBe(true);
    expect(summarize(validated)).toEqual(wholeDocument(text, "request"));
    expect(existsSync(spill)).toBe(false);
    expect(() => readProjectDataImportFile(bad, { envelope: "request", spillPath: spill })).toThrow(
      ProjectDataImportSyntaxError,
    );
    expect(existsSync(spill)).toBe(false);
  });
});
