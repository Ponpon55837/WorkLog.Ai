import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { AGENT_OBSERVATIONS_FILE, MCP_CONTRACT_FINGERPRINT_FILE } from "./mcp-contract-fingerprint.js";

export const RUNTIME_CURRENT_FILE_NAME = "current";
export const RUNTIME_DIRECTORIES_NAME = "runtimes";
export const RUNTIME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const AGENT_HOST_IDS = ["claude-code", "codex", "claude-desktop"] as const;
export type AgentHostId = (typeof AGENT_HOST_IDS)[number];

/**
 * `clientInfo.name` each host sends in MCP `initialize`. `claude-ai` for Claude Desktop is observed, not
 * vendor-documented. An unknown name is recorded but lights up no host.
 */
const CLIENT_NAME_TO_HOST: ReadonlyMap<string, AgentHostId> = new Map([
  ["claude-code", "claude-code"],
  ["codex-mcp-client", "codex"],
  ["codex", "codex"],
  ["claude-ai", "claude-desktop"],
]);

export function hostForClientName(clientName: string): AgentHostId | undefined {
  return CLIENT_NAME_TO_HOST.get(clientName.trim().toLowerCase());
}

export interface HostObservation {
  readonly contractFingerprint: string;
  readonly observedAt: string;
  readonly lease?: ObservedLease;
}

/**
 * Lease state recorded beside an observation: opaque scope id, writable flag, error code, no path. The file stays
 * `version: 1`; the field is additive.
 */
export interface ObservedLease {
  readonly scopeId: string;
  readonly directoryWritable: boolean;
  readonly failure?: "directory_unavailable" | "write_failed";
  readonly errorCode?: string;
}

const SCOPE_ID = /^[a-f0-9]{24}$/;
const LEASE_FAILURES: ReadonlySet<unknown> = new Set(["directory_unavailable", "write_failed"]);
const LEASE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,23}$/;

function leaseOf(value: unknown): ObservedLease | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { scopeId, directoryWritable, failure, errorCode } = value as Record<string, unknown>;
  if (typeof scopeId !== "string" || !SCOPE_ID.test(scopeId) || typeof directoryWritable !== "boolean")
    return undefined;
  return {
    scopeId,
    directoryWritable,
    ...(LEASE_FAILURES.has(failure) ? { failure: failure as ObservedLease["failure"] } : {}),
    ...(typeof errorCode === "string" && LEASE_ERROR_CODE.test(errorCode) ? { errorCode } : {}),
  };
}

const MAX_FILE_BYTES = 256 * 1024;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const RUNTIME_FINGERPRINT_PATH = ["app", "libexec", "apps", "mcp", "dist", MCP_CONTRACT_FINGERPRINT_FILE] as const;

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

export function readHostObservations(configDirectory: string): Partial<Record<AgentHostId, HostObservation>> {
  const entries = jsonObject(readSmallFile(join(configDirectory, AGENT_OBSERVATIONS_FILE)))?.observations;
  const result: Partial<Record<AgentHostId, HostObservation>> = {};
  if (entries === null || typeof entries !== "object") return result;
  for (const [clientName, value] of Object.entries(entries)) {
    const host = hostForClientName(clientName);
    if (host === undefined || !AGENT_HOST_IDS.includes(host) || value === null || typeof value !== "object") continue;
    const { contractFingerprint, observedAt, lease } = value as Record<string, unknown>;
    if (typeof contractFingerprint !== "string" || !FINGERPRINT.test(contractFingerprint)) continue;
    const at = typeof observedAt === "string" ? observedAt : "";
    const known = result[host];
    const observedLease = leaseOf(lease);
    if (known === undefined || at >= known.observedAt) {
      result[host] = { contractFingerprint, observedAt: at, ...(observedLease ? { lease: observedLease } : {}) };
    }
  }
  return result;
}

export function readCurrentContractFingerprint(runtimeRoot: string): string | undefined {
  const pointer = readSmallFile(join(runtimeRoot, RUNTIME_CURRENT_FILE_NAME));
  const id = pointer === undefined ? undefined : /^([^\r\n]*)\r?\n?$/.exec(pointer)?.[1];
  if (id === undefined || !RUNTIME_ID_PATTERN.test(id)) return undefined;
  const file = jsonObject(readSmallFile(join(runtimeRoot, RUNTIME_DIRECTORIES_NAME, id, ...RUNTIME_FINGERPRINT_PATH)));
  const fingerprint = file?.contractFingerprint;
  return typeof fingerprint === "string" && FINGERPRINT.test(fingerprint) ? fingerprint : undefined;
}

export type HostObservationState = "current" | "stale" | "none";

export function classifyHostObservation(
  observation: { readonly contractFingerprint: string } | undefined,
  currentContractFingerprint: string | undefined,
): HostObservationState {
  if (!observation) return "none";
  return currentContractFingerprint !== undefined && observation.contractFingerprint === currentContractFingerprint
    ? "current"
    : "stale";
}

export type McpLeaseCause =
  | "lease_unreported"
  /** The MCP could not create or write its lease directory. */
  | "directory_unwritable"
  /** The MCP and this backend name different lease scopes (another install or runtime root). */
  | "scope_mismatch"
  /** Same scope, writable directory, no live lease: the Agent has disconnected since. */
  | "agent_disconnected";

export interface McpLeaseDiagnosis {
  readonly backendScopeId: string;
  readonly observedScopeId?: string;
  readonly directoryWritable?: boolean;
  readonly activeLeases: number;
  readonly cause?: McpLeaseCause;
}

export function diagnoseMcpLease(
  observations: Partial<Record<AgentHostId, HostObservation>>,
  backendScopeId: string,
  activeLeases: number,
): McpLeaseDiagnosis {
  const observed = Object.values(observations);
  const newest = observed
    .filter((entry) => entry.lease !== undefined)
    .sort((left, right) =>
      left.observedAt < right.observedAt ? 1 : left.observedAt > right.observedAt ? -1 : 0,
    )[0]?.lease;
  const base = {
    backendScopeId,
    ...(newest ? { observedScopeId: newest.scopeId, directoryWritable: newest.directoryWritable } : {}),
    activeLeases,
  };
  if (observed.length === 0 || activeLeases > 0) return base;
  if (!newest) return { ...base, cause: "lease_unreported" };
  if (!newest.directoryWritable) return { ...base, cause: "directory_unwritable" };
  if (newest.scopeId !== backendScopeId) return { ...base, cause: "scope_mismatch" };
  return { ...base, cause: "agent_disconnected" };
}
