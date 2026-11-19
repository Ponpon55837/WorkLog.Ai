import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_OBSERVATIONS_FILE,
  MCP_CONTRACT_FINGERPRINT_FILE,
} from "@work-intelligence/shared/mcp-contract-fingerprint";
import { AGENT_HOST_IDS, hostForClientName, type AgentHostId } from "./host-clients.js";
import { isRuntimeId } from "../runtime/manifest.js";
import { runtimeDirectoryFor, runtimeLayout } from "../runtime/layout.js";

/** What the Agent page needs of one observation: the contract the host saw, and when. */
export interface HostObservation {
  readonly contractFingerprint: string;
  readonly observedAt: string;
}

/** The files are a few hundred bytes; anything past this is not ours and is read as absent. */
const MAX_FILE_BYTES = 256 * 1024;
const FINGERPRINT = /^[a-f0-9]{64}$/;
/** Where the packaged runtime keeps its fingerprint, relative to the runtime's own directory. */
const RUNTIME_FINGERPRINT_PATH = ["app", "libexec", "apps", "mcp", "dist", MCP_CONTRACT_FINGERPRINT_FILE] as const;

/** A small regular file as text, or undefined when it is missing, too big or unreadable. */
function readSmallFile(path: string): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return undefined;
    const buffer = Buffer.alloc(stats.size);
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(descriptor, buffer, read, buffer.length - read, read);
      if (count === 0) break;
      read += count;
    }
    return buffer.toString("utf8", 0, read);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function jsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The newest observation per Agent host in `agent-observations.json` of the config directory (the file the MCP server
 * writes when a real host completes `initialize` and `tools/list`). Client names are mapped to hosts by
 * {@link hostForClientName}; a name it does not know is ignored, and the desktop self-test is never recorded at all.
 * A missing, oversized or malformed file, or an entry without a fingerprint, counts as no observation. One small read,
 * no watching: the Agent page calls it once per refresh.
 */
export function readHostObservations(configDirectory: string): Partial<Record<AgentHostId, HostObservation>> {
  const entries = jsonObject(readSmallFile(join(configDirectory, AGENT_OBSERVATIONS_FILE)))?.observations;
  const result: Partial<Record<AgentHostId, HostObservation>> = {};
  if (entries === null || typeof entries !== "object") return result;
  for (const [clientName, value] of Object.entries(entries)) {
    const host = hostForClientName(clientName);
    if (host === undefined || !AGENT_HOST_IDS.includes(host) || value === null || typeof value !== "object") continue;
    const { contractFingerprint, observedAt } = value as Record<string, unknown>;
    if (typeof contractFingerprint !== "string" || !FINGERPRINT.test(contractFingerprint)) continue;
    const at = typeof observedAt === "string" ? observedAt : "";
    const known = result[host];
    // ISO timestamps compare as text; a missing time sorts first.
    if (known === undefined || at >= known.observedAt) result[host] = { contractFingerprint, observedAt: at };
  }
  return result;
}

/**
 * The tool-contract fingerprint of the runtime the launcher would start now: the `current` pointer, then the file the
 * build wrote beside that runtime's MCP bundles. Undefined when any step is missing or malformed (a runtime from a build
 * without the file, a pointer being switched), which keeps every observation from counting as current.
 */
export function readCurrentContractFingerprint(runtimeRoot: string): string | undefined {
  const pointer = readSmallFile(runtimeLayout(runtimeRoot).currentFile);
  const id = pointer === undefined ? undefined : /^([^\r\n]*)\r?\n?$/.exec(pointer)?.[1];
  if (id === undefined || !isRuntimeId(id)) return undefined;
  const file = jsonObject(readSmallFile(join(runtimeDirectoryFor(runtimeRoot, id), ...RUNTIME_FINGERPRINT_PATH)));
  const fingerprint = file?.contractFingerprint;
  return typeof fingerprint === "string" && FINGERPRINT.test(fingerprint) ? fingerprint : undefined;
}
