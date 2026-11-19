import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { AGENT_OBSERVATIONS_FILE, MCP_CONTRACT_FINGERPRINT_FILE } from "./mcp-contract-fingerprint.js";

/**
 * What an Agent host last saw of the MCP tool contract, and how that compares with the contract installed now. The
 * desktop App's Agent tab and the Web system status both read it from here, so the two never judge a host differently.
 */

/** Name of the single-line file in the runtime root that holds the current runtime id. */
export const RUNTIME_CURRENT_FILE_NAME = "current";
/** Folder of the runtime root that holds one immutable directory per installed runtime. */
export const RUNTIME_DIRECTORIES_NAME = "runtimes";
/** The shape of a legal runtime id (also the only characters allowed in a runtime directory name). */
export const RUNTIME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The Agent hosts the desktop App can show a connection state for. */
export const AGENT_HOST_IDS = ["claude-code", "codex", "claude-desktop"] as const;
export type AgentHostId = (typeof AGENT_HOST_IDS)[number];

/**
 * `clientInfo.name` each host sends in MCP `initialize`. Claude Code (`claude-code`, measured with 2.1.323) and Codex
 * (`codex-mcp-client`, from its source) are known; Claude Desktop is not documented by its vendor, so `claude-ai` is
 * the name its connector traffic is known to carry and may need a new row when a release changes it. A name missing
 * here is still recorded by the server, it just does not light up a host until someone adds it.
 */
const CLIENT_NAME_TO_HOST: ReadonlyMap<string, AgentHostId> = new Map([
  ["claude-code", "claude-code"],
  ["codex-mcp-client", "codex"],
  ["codex", "codex"],
  ["claude-ai", "claude-desktop"],
]);

/** The host a `clientInfo.name` belongs to, or undefined for a name this table does not know. */
export function hostForClientName(clientName: string): AgentHostId | undefined {
  return CLIENT_NAME_TO_HOST.get(clientName.trim().toLowerCase());
}

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
  const pointer = readSmallFile(join(runtimeRoot, RUNTIME_CURRENT_FILE_NAME));
  const id = pointer === undefined ? undefined : /^([^\r\n]*)\r?\n?$/.exec(pointer)?.[1];
  if (id === undefined || !RUNTIME_ID_PATTERN.test(id)) return undefined;
  const file = jsonObject(readSmallFile(join(runtimeRoot, RUNTIME_DIRECTORIES_NAME, id, ...RUNTIME_FINGERPRINT_PATH)));
  const fingerprint = file?.contractFingerprint;
  return typeof fingerprint === "string" && FINGERPRINT.test(fingerprint) ? fingerprint : undefined;
}

/** How one host's last observation compares with the contract installed now. */
export type HostObservationState = "current" | "stale" | "none";

/**
 * `current`: the host saw today's tool contract; `stale`: it saw an older one; `none`: never observed. Without a current
 * fingerprint nothing can be proven equal, so an observation is never `current` then.
 */
export function classifyHostObservation(
  observation: { readonly contractFingerprint: string } | undefined,
  currentContractFingerprint: string | undefined,
): HostObservationState {
  if (!observation) return "none";
  return currentContractFingerprint !== undefined && observation.contractFingerprint === currentContractFingerprint
    ? "current"
    : "stale";
}
