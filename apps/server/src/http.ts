import type { IncomingMessage, ServerResponse } from "node:http";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ApiErrorCode, ProjectFolderStatus, ProjectListRecord } from "@work-intelligence/core";
import { ProjectDataTransferError, canonicalizeProjectRoot } from "@work-intelligence/storage";

export const MAX_INPUT_PAYLOAD_BYTES = 1_500_000;
export const MAX_PROJECT_IMPORT_BYTES = 50 * 1024 * 1024;

export const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
};

export class RequestBodyError extends Error {
  public constructor(
    public readonly statusCode: 400 | 413 | 415,
    message: string,
  ) {
    super(message);
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
