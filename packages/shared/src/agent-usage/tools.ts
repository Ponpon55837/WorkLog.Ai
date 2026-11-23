import { isRecord } from "./metrics.js";

/** A classified tool: where it is counted and, for Work Intelligence tools, its operation key. */
export interface ToolInfo {
  name: string;
  work: boolean;
  mcp: boolean;
  /** Work Intelligence operation key; set when `work`. */
  key?: string;
  /** Codex only: the call was credited in range, and by which metrics. */
  counted?: boolean;
  owner?: object;
}

export const SAFE_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
const WORK_TOOL_NAME = /^mcp__.*__(work_[a-z_]+)$/;
/** Operation ids are echoed in reports, so only this shape is ever kept. */
const OPERATION_ID = /^work_[a-z0-9_]+$/;
/** Entry tools that dispatch on `input.operation`. */
const OPERATION_ENTRY_TOOLS = new Set([
  "work_read",
  "work_write_idempotent",
  "work_write_additive",
  "work_write_overwrite",
]);

/**
 * Key a Work Intelligence tool call is grouped under: `entry/operation` for dispatcher tools (`entry/(unknown)` when the
 * operation is absent or not shaped like an operation id), the tool name for direct tools. `readOperation` runs only
 * for dispatcher tools and may return anything; only the id shape is used.
 */
export function workOperationKey(entry: string, readOperation: () => unknown): string {
  if (!OPERATION_ENTRY_TOOLS.has(entry)) return entry;
  const operation = readOperation();
  return `${entry}/${typeof operation === "string" && OPERATION_ID.test(operation) ? operation : "(unknown)"}`;
}

/** Reads `.operation` from tool arguments given as an object or as a JSON string; never reads another field. */
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

/** Classifies a raw Claude tool name into the map it is counted under, never echoing an unsafe name. */
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
