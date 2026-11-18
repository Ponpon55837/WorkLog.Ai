import fsp from "node:fs/promises";
import path from "node:path";
import { LEASES_DIRECTORY_NAME } from "./layout.js";
import { LEASE_FILE_SUFFIX, LEASE_HEARTBEAT_MS, leaseDirectoryState, observeLeases } from "./lease.js";

/**
 * A lease the process of an Agent's connection keeps fresh counts as alive for this long after its last heartbeat. Three
 * heartbeats: one missed beat (a busy machine, a sleeping laptop) does not hide an Agent, and a crashed one stops counting
 * within a few minutes.
 */
export const AGENT_LEASE_MAX_AGE_MS = 3 * LEASE_HEARTBEAT_MS;

/** The launcher action an Agent's MCP connection runs; the App's own backend runs `serve` and never counts. */
const AGENT_ACTION = "mcp";

async function actionOf(file: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(file, "utf8"));
    const action = typeof parsed === "object" && parsed !== null ? (parsed as { action?: unknown }).action : undefined;
    return typeof action === "string" ? action : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How many Agent (MCP) connections of the launcher root look alive: lease files below `<root>/leases/<runtime>` whose action
 * is `mcp` and whose last heartbeat is recent. Read-only; a missing, linked or unreadable folder counts as none (the
 * database's own in-use check still runs before a restore replaces anything, so this is an early notice, not the guard).
 */
export async function countActiveAgentLeases(
  root: string,
  now: number = Date.now(),
  maxAgeMs: number = AGENT_LEASE_MAX_AGE_MS,
): Promise<number> {
  const leases = path.join(root, LEASES_DIRECTORY_NAME);
  if ((await leaseDirectoryState(leases)) !== "real") return 0;
  let runtimes: string[];
  try {
    runtimes = await fsp.readdir(leases);
  } catch {
    return 0;
  }
  let count = 0;
  for (const runtime of runtimes) {
    const directory = path.join(leases, runtime);
    for (const [name, modified] of await observeLeases(directory)) {
      if (!name.endsWith(LEASE_FILE_SUFFIX) || now - modified > maxAgeMs) continue;
      if ((await actionOf(path.join(directory, name))) === AGENT_ACTION) count += 1;
    }
  }
  return count;
}
