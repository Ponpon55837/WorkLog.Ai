import type { IncomingMessage, ServerResponse } from "node:http";
import { Buffer } from "node:buffer";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ApiErrorCode, ProjectFolderStatus, ProjectListRecord } from "@work-intelligence/core";
import {
  ProjectDataTransferError,
  ValidatedProjectDataImport,
  canonicalizeProjectRoot,
} from "@work-intelligence/storage";

export const MAX_INPUT_PAYLOAD_BYTES = 1_500_000;
export const MAX_PROJECT_IMPORT_BYTES = 50 * 1024 * 1024;

/**
 * Heap that `JSON.parse` keeps per container (`{` or `[`) and per input byte, measured with `--expose-gc` on Node 22
 * as the heapUsed delta after the parse. Per input byte: `{},` 22.3x, `[[]],` 20.2x, `[],` 14.3x, `{"a":1},` 6.0x, and
 * 2.07x (89 MiB) for a 42.9 MiB export bundle of 72,837 containers. The model is rounded up so it never falls below
 * a measurement: 72 B per container and 2 B per byte give 78 B for `{},` (measured 67), 154 B for `[[]],` (100) and
 * 95 MiB for that bundle (89).
 */
export const IMPORT_PARSED_BYTES_PER_CONTAINER = 72;
export const IMPORT_PARSED_BYTES_PER_BYTE = 2;
/**
 * The most parsed heap an import may need. Validation, redaction and planning then copy the document: the worker peaks
 * at 2.2 times the parse (193 MiB against 89 MiB for the bundle above), so 384 MiB keeps the worker near 850 MiB, below
 * its 1 GiB old-generation limit, while a legitimate 50 MiB bundle (about 100 to 300 MiB estimated) passes.
 */
export const MAX_PROJECT_IMPORT_PARSED_HEAP_BYTES = 384 * 1024 * 1024;

export const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
};

export class RequestBodyError extends Error {
  public constructor(
    public readonly statusCode: 400 | 413 | 415,
    message: string,
  ) {
    super(message);
    this.name = "RequestBodyError";
  }
}

function defaultApiErrorCode(statusCode: number): ApiErrorCode {
  switch (statusCode) {
    case 400:
      return "invalid_input";
    case 403:
      return "origin_not_allowed";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 413:
      return "payload_too_large";
    case 415:
      return "unsupported_media_type";
    case 421:
      return "host_not_allowed";
    case 503:
      return "service_unavailable";
    default:
      return "internal_error";
  }
}

export async function readJsonBody(request: IncomingMessage, maxBytes = MAX_INPUT_PAYLOAD_BYTES): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
    throw new RequestBodyError(415, "Content-Type must be application/json.");
  }

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new RequestBodyError(413, "Request body is too large.");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestBodyError(400, "Invalid JSON request body.");
  }
}

/** Reads bounded JSON bytes without parsing them on the request event loop. */
export async function readJsonBytesBody(
  request: IncomingMessage,
  maxBytes = MAX_INPUT_PAYLOAD_BYTES,
): Promise<Uint8Array> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
    throw new RequestBodyError(415, "Content-Type must be application/json.");
  }

  // A declared length lets each socket chunk be copied into its final buffer as it arrives, so the body never exists
  // twice (chunk list plus a concatenated copy) and the chunks can be reclaimed while the upload is still running.
  const declared = Number(request.headers["content-length"]);
  const known = Number.isSafeInteger(declared) && declared > 0 && declared <= maxBytes;
  let target = known ? new Uint8Array(declared) : new Uint8Array(0);
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (total + buffer.length > maxBytes) {
      throw new RequestBodyError(413, "Request body is too large.");
    }
    if (total + buffer.length > target.length) {
      const grown = new Uint8Array(Math.min(maxBytes, Math.max(total + buffer.length, target.length * 2)));
      grown.set(target.subarray(0, total));
      target = grown;
    }
    target.set(buffer, total);
    total += buffer.length;
  }

  if (total === 0) return Uint8Array.from([0x7b, 0x7d]);
  // A body that matches its declared length (the normal case) is already one exact buffer and can be transferred.
  return total === target.length ? target : target.slice(0, total);
}

/**
 * Counts the `{` and `[` bytes that are not inside a JSON string, in one pass. Bytes of multibyte UTF-8 sequences are
 * all 0x80 or above, so they never equal a quote, backslash or bracket. Strings are skipped with `indexOf`, which is
 * why a bundle of mostly text scans three times faster than a byte loop; a closing quote counts only when an even
 * number of backslashes precedes it.
 */
export function countJsonContainers(bytes: Uint8Array): number {
  let count = 0;
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index++];
    if (byte === 0x7b || byte === 0x5b) {
      count += 1;
    } else if (byte === 0x22) {
      for (;;) {
        const quote = bytes.indexOf(0x22, index);
        if (quote === -1) return count;
        let backslash = quote - 1;
        while (backslash >= index && bytes[backslash] === 0x5c) backslash -= 1;
        index = quote + 1;
        if ((quote - 1 - backslash) % 2 === 0) break;
      }
    }
  }
  return count;
}

/** Estimated heap that `JSON.parse` keeps for the document: every container plus every input byte. */
export function estimateProjectImportParsedHeapBytes(bytes: Uint8Array): number {
  return (
    countJsonContainers(bytes) * IMPORT_PARSED_BYTES_PER_CONTAINER + bytes.byteLength * IMPORT_PARSED_BYTES_PER_BYTE
  );
}

/**
 * Rejects, before `JSON.parse`, a document whose parsed form would not fit the worker's heap. V8 cannot interrupt the
 * native parse: when a worker's heap limit is reached inside it, Node raises the limit in steps and finally aborts the
 * whole process (measured: 278 MB reached under a 64 MB limit, then "FATAL ERROR: Reached heap limit"). On Node 24 a
 * worker heap exhaustion can abort the whole process even in ordinary JavaScript, so this check is the guard, not the
 * worker's own limit. Small containers are the dangerous shape: a body of `{},` costs 22 times its size in heap.
 * The budget parameter exists for tests; production callers use the default.
 */
export function assertProjectImportFitsHeap(
  bytes: Uint8Array,
  budget: number = MAX_PROJECT_IMPORT_PARSED_HEAP_BYTES,
): void {
  if (estimateProjectImportParsedHeapBytes(bytes) > budget) {
    throw new RequestBodyError(413, "匯入檔內容結構過於龐大，無法安全處理；請改為分批匯出較小的專案資料。");
  }
}

/** Parses and validates an import payload after it reaches the worker or inline fallback. */
/** Parses an import request body and validates it once; the result goes straight to the planner. */
export function parseProjectDataImportBytes(bytes: Uint8Array): ValidatedProjectDataImport {
  assertProjectImportFitsHeap(bytes);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8"));
  } catch {
    throw new RequestBodyError(400, "Invalid JSON request body.");
  }
  return ValidatedProjectDataImport.validate(value);
}

/** The JSON body as an object, so a route can merge path parameters into it before validation. */
export async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  return (await readJsonBody(request)) as Record<string, unknown>;
}

export function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, JSON_HEADERS);
  response.end(JSON.stringify(payload));
}

export function sendError(
  response: ServerResponse,
  statusCode: number,
  message: string,
  details?: unknown,
  code: ApiErrorCode = defaultApiErrorCode(statusCode),
): void {
  sendJson(response, statusCode, { error: message, code, details });
}

/** Sends the API error for a project import or export failure; false when `error` is something else. */
export function sendProjectDataTransferError(response: ServerResponse, error: unknown): boolean {
  if (!(error instanceof ProjectDataTransferError)) {
    return false;
  }
  switch (error.code) {
    case "project_not_found":
      sendError(response, 404, error.message, undefined, error.code);
      return true;
    case "invalid_input":
    case "invalid_bundle":
    case "unsupported_schema":
      sendError(response, 400, error.message, undefined, error.code);
      return true;
    case "project_backup_failed":
      sendError(
        response,
        503,
        "The required pre-import backup could not be created; nothing was imported.",
        undefined,
        error.code,
      );
      return true;
  }
}

export function inspectProjectFolder(rootPath: string): ProjectFolderStatus {
  if (!isAbsolute(rootPath) || rootPath.includes("\0")) {
    return "missing";
  }
  try {
    return statSync(canonicalizeProjectRoot(rootPath)).isDirectory() ? "found" : "missing";
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unavailable";
  }
}

export function withProjectFolderStatus(
  project: ProjectListRecord | Omit<ProjectListRecord, "folderStatus">,
): ProjectListRecord {
  return { ...project, folderStatus: inspectProjectFolder(project.rootPath) };
}

/** A query parameter as a number, or undefined when absent (validation happens in the schema). */
export function numberParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  return value ? Number(value) : undefined;
}

/** A trimmed query parameter, or undefined when absent or blank. */
export function textParam(url: URL, name: string): string | undefined {
  return url.searchParams.get(name)?.trim() || undefined;
}
