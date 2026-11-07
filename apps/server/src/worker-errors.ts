import { ProjectDataTransferError, type ProjectDataTransferErrorCode } from "@work-intelligence/storage";
import { RequestBodyError } from "./http.js";

/** Error fields that survive a worker boundary; messages stay as the store produced them. */
export interface SerializedWorkerError {
  name: string;
  message: string;
  code?: unknown;
  errcode?: unknown;
  errstr?: unknown;
  statusCode?: unknown;
  cause?: SerializedWorkerError;
}

export function serializeError(error: unknown, depth = 0): SerializedWorkerError {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown; errcode?: unknown; errstr?: unknown; statusCode?: unknown };
    const cause = error.cause !== undefined && depth < 5 ? serializeError(error.cause, depth + 1) : undefined;
    return {
      name: error.name,
      message: error.message,
      ...(candidate.code === undefined ? {} : { code: candidate.code }),
      ...(candidate.errcode === undefined ? {} : { errcode: candidate.errcode }),
      ...(candidate.errstr === undefined ? {} : { errstr: candidate.errstr }),
      ...(candidate.statusCode === undefined ? {} : { statusCode: candidate.statusCode }),
      ...(cause ? { cause } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

export function restoredError(error: SerializedWorkerError): Error {
  if (
    error.name === "RequestBodyError" &&
    (error.statusCode === 400 || error.statusCode === 413 || error.statusCode === 415)
  ) {
    return new RequestBodyError(error.statusCode, error.message);
  }
  const transferCodes: ProjectDataTransferErrorCode[] = [
    "invalid_input",
    "invalid_bundle",
    "unsupported_schema",
    "project_not_found",
  ];
  if (transferCodes.includes(error.code as ProjectDataTransferErrorCode)) {
    return new ProjectDataTransferError(error.code as ProjectDataTransferErrorCode, error.message);
  }
  const cause = error.cause ? restoredError(error.cause) : undefined;
  return Object.assign(new Error(error.message, cause ? { cause } : undefined), {
    name: error.name,
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.errcode === undefined ? {} : { errcode: error.errcode }),
    ...(error.errstr === undefined ? {} : { errstr: error.errstr }),
  });
}
