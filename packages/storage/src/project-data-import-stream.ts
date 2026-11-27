import { Buffer } from "node:buffer";
import { closeSync, openSync, readSync } from "node:fs";
import {
  PROJECT_DATA_TABLES,
  type ProjectDataImportInput,
  type ProjectDataRow,
  type ProjectDataTable,
} from "@work-intelligence/core";
import {
  MAX_PROJECT_DATA_ROWS,
  PROJECT_DATA_IMPORT_TABLE_ORDER,
  checkProjectDataBundleSummary,
  createProjectDataRowChecker,
  projectDataImportEnvelopeSchema,
  projectDataImportOptionsSchema,
  projectDataImportRowSchema,
  validationIssueMessage,
  type ProjectDataBundleIssue,
  type ProjectDataRowChecker,
} from "@work-intelligence/schema";
import { redactArchitectureDiagramSource } from "./diagram-source-redaction.js";
import { ProjectDataSpill } from "./project-data-spill.js";
import { redactRow } from "./project-data-export.js";
import { combineRedactionSummaries } from "./secret-redaction.js";
import {
  ProjectDataTransferError,
  ValidatedProjectDataImport,
  assertImportableSchemaVersion,
  plannerColumns,
} from "./project-data-transfer.js";

// The first error reported must be the one the whole-bundle path reports.
export type ProjectDataImportEnvelope = "request" | "bundle";

export interface ProjectDataImportStreamOptions {
  envelope: ProjectDataImportEnvelope;
  spillPath: string;
  inlineCharacters?: number;
}

export type ProjectDataImportSyntaxErrorKind = "invalid_json" | "row_too_large";

export class ProjectDataImportSyntaxError extends Error {
  public constructor(public readonly kind: ProjectDataImportSyntaxErrorKind) {
    super(kind === "invalid_json" ? "Invalid JSON request body." : "匯入檔中有單筆資料過大，無法匯入。");
    this.name = "ProjectDataImportSyntaxError";
  }
}

type Container = "root" | "bundle" | "tables";

interface ObjectFrame {
  kind: "object";
  container: Container;
  target: Record<string, unknown>;
  state: "keyOrEnd" | "key" | "colon" | "value" | "commaOrEnd";
  key: string;
}

interface RowsFrame {
  kind: "rows";
  table: ProjectDataTable;
  state: "valueOrEnd" | "value" | "commaOrEnd";
  index: number;
}

type Frame = ObjectFrame | RowsFrame;

interface Capture {
  start: number;
  scan: number;
  depth: number;
  stack: Uint8Array;
  inString: boolean;
  nested: Array<[number, number]>;
  nestedStart: number;
  limit: number;
  row: boolean;
}

export const MAX_IMPORT_ROW_BYTES = 32 * 1024 * 1024;
const MAX_ENVELOPE_VALUE_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_INLINE_CHARACTERS = 0;
const SPACE = 0x20;
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
/** Some editors write it; JSON.parse of a decoded string never sees it. */
const UTF8_BOM = [0xef, 0xbb, 0xbf];
const KNOWN_TABLES: ReadonlySet<string> = new Set(PROJECT_DATA_TABLES);
const REQUEST_KEY_ORDER = ["bundle", "projectId", "remap", "strategy"];
const BUNDLE_KEY_ORDER = ["format", "formatVersion", "schemaVersion", "exportedAt", "scope", "tables"];

function isSpace(byte: number): boolean {
  return byte === SPACE || byte === LF || byte === CR || byte === TAB;
}

function issueOrder(issue: { path: PropertyKey[]; code?: string }): number[] {
  const order: number[] = [];
  const [first, second] = issue.path;
  issue.path.forEach((segment, depth) => {
    if (typeof segment === "number") {
      order.push(segment);
      return;
    }
    const keys =
      depth === 0
        ? REQUEST_KEY_ORDER
        : depth === 1 && first === "bundle"
          ? BUNDLE_KEY_ORDER
          : depth === 2 && first === "bundle" && second === "tables"
            ? PROJECT_DATA_IMPORT_TABLE_ORDER
            : undefined;
    order.push(Math.max(0, keys?.indexOf(segment as string) ?? 0));
  });
  if (issue.code === "unrecognized_keys") order.push(Number.POSITIVE_INFINITY);
  return order;
}

function compareIssueOrder(left: number[], right: number[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = (left[index] as number) - (right[index] as number);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

type ZodIssueLike = { code: string; message: string; path: PropertyKey[]; keys?: string[] };

function tooManyRowsIssue(table: ProjectDataTable): ZodIssueLike {
  return {
    code: "too_big",
    message: `${table} 超過 ${MAX_PROJECT_DATA_ROWS.toLocaleString("en-US")} 列的上限。`,
    path: ["bundle", "tables", table],
  };
}

function invalidFormat(issue: ZodIssueLike | ProjectDataBundleIssue): ProjectDataTransferError {
  return new ProjectDataTransferError(
    "invalid_input",
    `匯入檔格式錯誤：${validationIssueMessage({ code: "custom", ...issue }) ?? "欄位驗證失敗。"}`,
  );
}

class TableState {
  public rows: ProjectDataRow[] = [];
  public count = 0;
  public tooManyRows = false;
  public structuralIssue?: ZodIssueLike;
  public contentIssue?: ProjectDataBundleIssue;
  public readonly checkRow: ProjectDataRowChecker;
  public readonly ids = new Set<string>();
  public readonly redactedRows: Array<[ProjectDataRow, number]> = [];
  public readonly redactions = combineRedactionSummaries();

  public constructor(table: ProjectDataTable) {
    this.checkRow = createProjectDataRowChecker(table);
  }
}

class ProjectDataImportStreamReader {
  private buffer = new Uint8Array(READ_CHUNK_BYTES);
  private start = 0;
  private end = 0;
  private position = 0;
  private readonly frames: Frame[] = [];
  private capture?: Capture;
  private rootDone = false;
  private rootStarted = false;
  private received = 0;
  private root: unknown;
  private bundle?: Record<string, unknown>;
  private tables?: Record<string, unknown>;
  private tableStates = new Map<ProjectDataTable, TableState>();
  private readonly spill: ProjectDataSpill;
  private readonly inlineCharacters: number;
  private structuralFailure = false;
  private contentFailure = false;
  private bomSeen = 0;
  private bomDone = false;

  public constructor(private readonly options: ProjectDataImportStreamOptions) {
    this.spill = new ProjectDataSpill(options.spillPath);
    this.inlineCharacters = options.inlineCharacters ?? DEFAULT_INLINE_CHARACTERS;
  }

  public push(chunk: Uint8Array): void {
    this.append(this.dropByteOrderMark(chunk));
    this.scan();
  }

  private dropByteOrderMark(chunk: Uint8Array): Uint8Array {
    if (this.bomDone) return chunk;
    let offset = 0;
    while (offset < chunk.byteLength && this.bomSeen < UTF8_BOM.length && chunk[offset] === UTF8_BOM[this.bomSeen]) {
      this.bomSeen += 1;
      offset += 1;
    }
    this.received += offset;
    if (offset === chunk.byteLength && this.bomSeen < UTF8_BOM.length) return new Uint8Array(0);
    this.bomDone = true;
    if (this.bomSeen === UTF8_BOM.length) return chunk.subarray(offset);
    this.received -= this.bomSeen;
    const kept = new Uint8Array(this.bomSeen + chunk.byteLength - offset);
    kept.set(UTF8_BOM.slice(0, this.bomSeen));
    kept.set(chunk.subarray(offset), this.bomSeen);
    return kept;
  }

  public finish(): ValidatedProjectDataImport {
    try {
      if (!this.bomDone && this.bomSeen > 0) this.append(Uint8Array.from(UTF8_BOM.slice(0, this.bomSeen)));
      this.scan();
      this.finishScan();
      return this.validate();
    } catch (error) {
      this.spill.dispose();
      throw error;
    }
  }

  public abort(): void {
    this.spill.dispose();
  }

  private append(chunk: Uint8Array): void {
    const pending = this.end - this.start;
    if (pending + chunk.byteLength > this.buffer.byteLength - this.start) {
      if (pending + chunk.byteLength <= this.buffer.byteLength && this.start > 0) {
        this.buffer.copyWithin(0, this.start, this.end);
      } else {
        const grown = new Uint8Array(Math.max(this.buffer.byteLength * 2, pending + chunk.byteLength));
        grown.set(this.buffer.subarray(this.start, this.end));
        this.buffer = grown;
      }
      this.shift(this.start);
    }
    this.buffer.set(chunk, this.end);
    this.end += chunk.byteLength;
    this.received += chunk.byteLength;
  }

  private shift(by: number): void {
    this.start -= by;
    this.end -= by;
    this.position -= by;
    if (this.capture) {
      this.capture.start -= by;
      this.capture.scan -= by;
      this.capture.nestedStart -= by;
      for (const range of this.capture.nested) {
        range[0] -= by;
        range[1] -= by;
      }
    }
  }

  private scan(): void {
    for (;;) {
      if (this.capture) {
        const capture = this.capture;
        const done = this.continueCapture(capture);
        if (!done) return;
        this.capture = undefined;
        this.completeCapture(capture, done);
        continue;
      }
      if (!this.skipSpace()) return;
      if (this.rootDone) throw new ProjectDataImportSyntaxError("invalid_json");
      const byte = this.buffer[this.position] as number;
      this.step(byte);
      this.start = (this.capture as Capture | undefined)?.start ?? this.position;
    }
  }

  private skipSpace(): boolean {
    while (this.position < this.end && isSpace(this.buffer[this.position] as number)) this.position += 1;
    this.start = this.position;
    return this.position < this.end;
  }

  private step(byte: number): void {
    const frame = this.frames.at(-1);
    if (!frame) {
      if (this.rootStarted) throw new ProjectDataImportSyntaxError("invalid_json");
      this.rootStarted = true;
      if (byte === OPEN_OBJECT) {
        this.position += 1;
        const target: Record<string, unknown> = {};
        if (this.options.envelope === "request") {
          this.root = target;
          this.frames.push({ kind: "object", container: "root", target, state: "keyOrEnd", key: "" });
        } else {
          this.root = { bundle: target };
          this.beginBundle(target);
        }
        return;
      }
      this.beginCapture(false);
      return;
    }
    if (frame.kind === "rows") this.stepRows(frame, byte);
    else this.stepObject(frame, byte);
  }

  private stepObject(frame: ObjectFrame, byte: number): void {
    switch (frame.state) {
      case "keyOrEnd":
      case "key":
        if (byte === CLOSE_OBJECT && frame.state === "keyOrEnd") {
          this.position += 1;
          this.closeFrame();
          return;
        }
        if (byte !== QUOTE) throw new ProjectDataImportSyntaxError("invalid_json");
        this.beginCapture(false);
        return;
      case "colon":
        if (byte !== COLON) throw new ProjectDataImportSyntaxError("invalid_json");
        this.position += 1;
        frame.state = "value";
        return;
      case "value":
        this.beginObjectValue(frame, byte);
        return;
      case "commaOrEnd":
        this.position += 1;
        if (byte === COMMA) frame.state = "key";
        else if (byte === CLOSE_OBJECT) this.closeFrame();
        else throw new ProjectDataImportSyntaxError("invalid_json");
        return;
    }
  }

  private beginObjectValue(frame: ObjectFrame, byte: number): void {
    const descend =
      (frame.container === "root" && frame.key === "bundle" && byte === OPEN_OBJECT) ||
      (frame.container === "bundle" && frame.key === "tables" && byte === OPEN_OBJECT);
    if (descend) {
      this.position += 1;
      const target: Record<string, unknown> = {};
      frame.target[frame.key] = target;
      frame.state = "commaOrEnd";
      if (frame.container === "root") this.beginBundle(target);
      else this.beginTables(target);
      return;
    }
    if (frame.container === "tables" && KNOWN_TABLES.has(frame.key) && byte === OPEN_ARRAY) {
      this.position += 1;
      const table = frame.key as ProjectDataTable;
      frame.target[table] = [];
      frame.state = "commaOrEnd";
      // A repeated key replaces the earlier value, as JSON.parse does.
      this.tableStates.set(table, new TableState(table));
      this.frames.push({ kind: "rows", table, state: "valueOrEnd", index: 0 });
      return;
    }
    this.beginCapture(false);
    return;
  }

  private stepRows(frame: RowsFrame, byte: number): void {
    if (frame.state === "commaOrEnd") {
      this.position += 1;
      if (byte === COMMA) frame.state = "value";
      else if (byte === CLOSE_ARRAY) this.frames.pop();
      else throw new ProjectDataImportSyntaxError("invalid_json");
      return;
    }
    if (byte === CLOSE_ARRAY && frame.state === "valueOrEnd") {
      this.position += 1;
      this.frames.pop();
      return;
    }
    this.beginCapture(true);
    return;
  }

  private beginBundle(target: Record<string, unknown>): void {
    // A repeated "bundle" or "tables" key replaces everything read for the earlier one, as JSON.parse does.
    this.bundle = target;
    this.tables = undefined;
    this.tableStates = new Map();
    this.frames.push({ kind: "object", container: "bundle", target, state: "keyOrEnd", key: "" });
  }

  private beginTables(target: Record<string, unknown>): void {
    this.tables = target;
    this.tableStates = new Map();
    this.frames.push({ kind: "object", container: "tables", target, state: "keyOrEnd", key: "" });
  }

  private closeFrame(): void {
    this.frames.pop();
    if (this.frames.length === 0) this.rootDone = true;
  }

  private beginCapture(row: boolean): void {
    this.capture = {
      start: this.position,
      scan: this.position,
      depth: 0,
      stack: new Uint8Array(16),
      inString: false,
      nested: [],
      nestedStart: -1,
      limit: row ? MAX_IMPORT_ROW_BYTES : MAX_ENVELOPE_VALUE_BYTES,
      row,
    };
  }

  /** Multibyte UTF-8 bytes are all 0x80 or above, so they never look like structure. */
  private continueCapture(capture: Capture): number | undefined {
    const buffer = this.buffer;
    let index = capture.scan;
    const first = buffer[capture.start] as number;
    if (first !== OPEN_OBJECT && first !== OPEN_ARRAY && first !== QUOTE) {
      while (index < this.end) {
        const byte = buffer[index] as number;
        if (isSpace(byte) || byte === COMMA || byte === CLOSE_OBJECT || byte === CLOSE_ARRAY || byte === COLON) {
          return index;
        }
        index += 1;
        if (index - capture.start > capture.limit) this.overLimit(capture);
      }
      capture.scan = index;
      return undefined;
    }
    while (index < this.end) {
      if (capture.inString) {
        // Only up to `end`: past it the buffer holds stale bytes of an earlier, larger value.
        const quote = buffer.subarray(0, this.end).indexOf(QUOTE, index);
        if (quote === -1 || quote >= this.end) {
          index = this.end;
          break;
        }
        let backslash = quote - 1;
        while (backslash >= capture.start && buffer[backslash] === BACKSLASH) backslash -= 1;
        index = quote + 1;
        if ((quote - 1 - backslash) % 2 === 0) {
          capture.inString = false;
          if (capture.depth === 0) return this.checkedEnd(capture, index);
        }
        continue;
      }
      const byte = buffer[index] as number;
      index += 1;
      if (byte === QUOTE) {
        capture.inString = true;
      } else if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) {
        if (capture.depth === capture.stack.byteLength) {
          const grown = new Uint8Array(capture.stack.byteLength * 2);
          grown.set(capture.stack);
          capture.stack = grown;
        }
        capture.stack[capture.depth] = byte;
        capture.depth += 1;
        if (capture.row && capture.depth === 2) capture.nestedStart = index - 1;
      } else if (byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) {
        capture.depth -= 1;
        if (capture.depth < 0) throw new ProjectDataImportSyntaxError("invalid_json");
        const open = capture.stack[capture.depth];
        if ((byte === CLOSE_OBJECT ? OPEN_OBJECT : OPEN_ARRAY) !== open) {
          throw new ProjectDataImportSyntaxError("invalid_json");
        }
        if (capture.row && capture.depth === 1 && capture.nestedStart >= 0) {
          capture.nested.push([capture.nestedStart, index]);
          capture.nestedStart = -1;
        }
        if (capture.depth === 0) return this.checkedEnd(capture, index);
      }
    }
    capture.scan = index;
    if (index - capture.start > capture.limit) this.overLimit(capture);
    return undefined;
  }

  private checkedEnd(capture: Capture, end: number): number {
    if (end - capture.start > capture.limit) this.overLimit(capture);
    return end;
  }

  private overLimit(capture: Capture): never {
    if (capture.row) throw new ProjectDataImportSyntaxError("row_too_large");
    throw new ProjectDataTransferError("invalid_input", "匯入檔格式錯誤：內容結構異常或過於龐大。");
  }

  private completeCapture(capture: Capture, end: number): void {
    this.position = end;
    const frame = this.frames.at(-1);
    if (frame?.kind === "rows") {
      this.acceptRow(frame, this.parseRow(capture, end));
      frame.state = "commaOrEnd";
      return;
    }
    const value = this.parseValue(capture.start, end);
    if (!frame) {
      this.root = value;
      this.rootDone = true;
      return;
    }
    if (frame.state === "key" || frame.state === "keyOrEnd") {
      if (typeof value !== "string") throw new ProjectDataImportSyntaxError("invalid_json");
      frame.key = value;
      frame.state = "colon";
      return;
    }
    frame.target[frame.key] = value;
    frame.state = "commaOrEnd";
    if (frame.container === "tables" && KNOWN_TABLES.has(frame.key))
      this.tableStates.delete(frame.key as ProjectDataTable);
  }

  private text(from: number, to: number): string {
    return Buffer.from(this.buffer.buffer, this.buffer.byteOffset + from, to - from).toString("utf8");
  }

  private parseValue(from: number, to: number): unknown {
    try {
      return JSON.parse(this.text(from, to));
    } catch {
      throw new ProjectDataImportSyntaxError("invalid_json");
    }
  }

  /** Nested values become `{}` before parsing, so a hostile body of nested brackets is never built in memory. */
  private parseRow(capture: Capture, end: number): unknown {
    let text: string;
    if (capture.nested.length === 0) {
      text = this.text(capture.start, end);
    } else {
      const parts: string[] = [];
      let from = capture.start;
      for (const [nestedStart, nestedEnd] of capture.nested) {
        parts.push(this.text(from, nestedStart), "{}");
        from = nestedEnd;
      }
      parts.push(this.text(from, end));
      text = parts.join("");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ProjectDataImportSyntaxError("invalid_json");
    }
  }

  private acceptRow(frame: RowsFrame, value: unknown): void {
    const index = frame.index;
    frame.index += 1;
    const state = this.tableStates.get(frame.table);
    if (!state) return;
    if (index >= MAX_PROJECT_DATA_ROWS) {
      state.tooManyRows = true;
      this.structuralFailure = true;
      state.rows = [];
      return;
    }
    if (state.tooManyRows || state.structuralIssue) return;
    const parsed = projectDataImportRowSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0] as ZodIssueLike;
      state.structuralIssue = { ...issue, path: ["bundle", "tables", frame.table, index, ...issue.path] };
      this.structuralFailure = true;
      state.rows = [];
      return;
    }
    const row = value as ProjectDataRow;
    state.count += 1;
    if (this.structuralFailure) return;
    if (!state.contentIssue) {
      state.checkRow(row, index, (issue) => {
        state.contentIssue ??= issue;
      });
      if (state.contentIssue) this.contentFailure = true;
    }
    if (frame.table === "projects") state.ids.add(String(row.id));
    if (this.contentFailure) return;
    const redacted = redactRow(frame.table, row, redactArchitectureDiagramSource);
    const rowCount = redacted.redactions.total;
    if (rowCount > 0) {
      const totals = state.redactions;
      totals.total += rowCount;
      for (const [kind, count] of Object.entries(redacted.redactions.byKind)) {
        const key = kind as keyof typeof totals.byKind;
        totals.byKind[key] = (totals.byKind[key] ?? 0) + (count ?? 0);
      }
    }
    const keep = plannerColumns(frame.table);
    const light = this.spill.split(
      frame.table,
      redacted.row,
      (column, value) => typeof value !== "string" || keep.has(column) || value.length <= this.inlineCharacters,
    );
    state.rows.push(light);
    if (rowCount > 0) state.redactedRows.push([light, rowCount]);
  }

  private finishScan(): void {
    if (this.capture) {
      const end = this.capture.row ? undefined : this.end;
      const first = this.buffer[this.capture.start] as number;
      if (end === undefined || first === OPEN_OBJECT || first === OPEN_ARRAY || first === QUOTE) {
        throw new ProjectDataImportSyntaxError("invalid_json");
      }
      const capture = this.capture;
      this.capture = undefined;
      this.completeCapture(capture, end);
    }
    if (!this.rootStarted) {
      // An empty request body is `{}`, as the REST route has always read it; an empty export file is not JSON.
      if (this.received > 0 || this.options.envelope !== "request")
        throw new ProjectDataImportSyntaxError("invalid_json");
      this.root = {};
      return;
    }
    if (!this.rootDone || this.frames.length > 0) throw new ProjectDataImportSyntaxError("invalid_json");
  }

  private validate(): ValidatedProjectDataImport {
    const envelope = projectDataImportEnvelopeSchema.safeParse(this.root);
    const structural: ZodIssueLike[] = envelope.success ? [] : (envelope.error.issues as ZodIssueLike[]);
    for (const [table, state] of this.tableStates) {
      if (state.tooManyRows) structural.push(tooManyRowsIssue(table));
      else if (state.structuralIssue) structural.push(state.structuralIssue);
    }
    if (structural.length > 0) {
      const ranked = structural.map((issue) => ({ issue, order: issueOrder(issue) }));
      ranked.sort((left, right) => compareIssueOrder(left.order, right.order));
      throw invalidFormat((ranked[0] as { issue: ZodIssueLike }).issue);
    }
    if (!envelope.success) throw new Error("Unreachable: an envelope without issues failed.");
    const data = envelope.data;
    for (const table of PROJECT_DATA_TABLES) {
      const issue = this.tableStates.get(table)?.contentIssue;
      if (issue) throw invalidFormat({ ...issue, path: ["bundle", ...issue.path] });
    }
    const projects = this.tableStates.get("projects");
    let totalRows = 0;
    for (const state of this.tableStates.values()) totalRows += state.count;
    checkProjectDataBundleSummary(
      { totalRows, scope: data.bundle.scope, hasProject: (id) => projects?.ids.has(id) === true },
      (issue) => {
        throw invalidFormat({ ...issue, path: ["bundle", ...issue.path] });
      },
    );
    const { bundle, ...choices } = data;
    const options = projectDataImportOptionsSchema.safeParse(choices);
    if (!options.success) throw invalidFormat(options.error.issues[0] as ZodIssueLike);
    assertImportableSchemaVersion(bundle.schemaVersion);

    // Table order as redactProjectDataRows builds it, so the import audit's source digest matches the bundle path.
    const tables = Object.fromEntries(
      PROJECT_DATA_TABLES.map((table) => [table, this.tableStates.get(table)?.rows ?? []]),
    ) as unknown as Record<ProjectDataTable, ProjectDataRow[]>;
    this.addRedactionCounts(tables);
    this.spill.flush();
    const input: ProjectDataImportInput = { ...data, bundle: { ...bundle, tables } };
    const redactions = combineRedactionSummaries(...[...this.tableStates.values()].map((state) => state.redactions));
    return ValidatedProjectDataImport.fromStream(input, redactions, this.spill);
  }

  /** A Session's rows can come later in the file than the Session, so counts are added once every row is in. */
  private addRedactionCounts(tables: Record<ProjectDataTable, ProjectDataRow[]>): void {
    const itemSessions = new Map(
      (tables.outstanding_cleanup_request_items ?? []).map((item) => [String(item.id), String(item.source_session_id)]),
    );
    const proposalSessions = new Map(
      (tables.outstanding_cleanup_proposals ?? []).flatMap((proposal) => {
        const session = itemSessions.get(String(proposal.request_item_id));
        return session ? [[String(proposal.id), session] as const] : [];
      }),
    );
    const sessionCounts = new Map<string, number>();
    for (const [table, state] of this.tableStates) {
      for (const [row, count] of state.redactedRows) {
        const sessionId =
          table === "sessions"
            ? String(row.id)
            : String(
                row.session_id ??
                  row.source_session_id ??
                  (table === "outstanding_cleanup_proposals" ? proposalSessions.get(String(row.id)) : "") ??
                  "",
              );
        if (sessionId) sessionCounts.set(sessionId, (sessionCounts.get(sessionId) ?? 0) + count);
      }
    }
    if (!tables.sessions) return;
    tables.sessions = tables.sessions.map((session) => {
      const added = sessionCounts.get(String(session.id)) ?? 0;
      if (added === 0 && typeof session.redaction_count === "number") return session;
      return { ...session, redaction_count: Number(session.redaction_count ?? 0) + added };
    });
  }
}

export function readProjectDataImportBytes(
  bytes: Uint8Array,
  options: ProjectDataImportStreamOptions,
  chunkBytes = READ_CHUNK_BYTES,
): ValidatedProjectDataImport {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1)
    throw new RangeError("chunkBytes must be a positive integer.");
  const reader = new ProjectDataImportStreamReader(options);
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
      reader.push(bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkBytes)));
    }
  } catch (error) {
    reader.abort();
    throw error;
  }
  return reader.finish();
}

export function readProjectDataImportFile(
  path: string,
  options: ProjectDataImportStreamOptions,
): ValidatedProjectDataImport {
  const reader = new ProjectDataImportStreamReader(options);
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (read === 0) break;
      reader.push(chunk.subarray(0, read));
    }
  } catch (error) {
    reader.abort();
    throw error;
  } finally {
    closeSync(fd);
  }
  return reader.finish();
}
