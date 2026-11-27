import { isRecord } from "./metrics.js";

export interface ToolInfo {
  name: string;
  work: boolean;
  mcp: boolean;
  key?: string;
  counted?: boolean;
  owner?: object;
}

export const SAFE_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
const WORK_TOOL_NAME = /^mcp__.*__(work_[a-z_]+)$/;
const OPERATION_ID = /^work_[a-z0-9_]+$/;
const OPERATION_ENTRY_TOOLS = new Set([
  "work_read",
  "work_write_idempotent",
  "work_write_additive",
  "work_write_overwrite",
]);

export function workOperationKey(entry: string, readOperation: () => unknown): string {
  if (!OPERATION_ENTRY_TOOLS.has(entry)) return entry;
  const operation = readOperation();
  return `${entry}/${typeof operation === "string" && OPERATION_ID.test(operation) ? operation : "(unknown)"}`;
}

export function operationOf(args: unknown): unknown {
  let value = args;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return isRecord(value) ? value.operation : undefined;
}

export function classifyTool(rawName: unknown, input: unknown): ToolInfo {
  if (typeof rawName !== "string" || !SAFE_TOOL_NAME.test(rawName)) return { name: "(other)", work: false, mcp: false };
  const work = WORK_TOOL_NAME.exec(rawName);
  const entry = work?.[1];
  if (entry !== undefined) {
    return {
      name: entry,
      work: true,
      mcp: true,
      key: workOperationKey(entry, () => (isRecord(input) ? input.operation : undefined)),
    };
  }
  return { name: rawName, work: false, mcp: rawName.startsWith("mcp__") };
}

const FILE_PATH_FIELDS: Record<string, string> = {
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

export function filePathOf(rawName: unknown, input: unknown): string | undefined {
  const field = typeof rawName === "string" ? FILE_PATH_FIELDS[rawName] : undefined;
  if (field === undefined || !isRecord(input)) return undefined;
  const value = input[field];
  return typeof value === "string" ? value : undefined;
}

export function projectRootOf(args: unknown): string | undefined {
  let value = args;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(value)) return undefined;
  const nested = isRecord(value.arguments) ? value.arguments.projectRoot : undefined;
  const root = typeof nested === "string" ? nested : value.projectRoot;
  return typeof root === "string" ? root : undefined;
}
