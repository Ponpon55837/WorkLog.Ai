import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeFileAtomic } from "../internal/atomic-file.js";
import { errorCode } from "../internal/error-code.js";
import {
  IDS_CASE_INSENSITIVE,
  QUARANTINE_DIRECTORY_PREFIX,
  RUNTIMES_DIRECTORY_NAME,
  readCurrentRuntimeId,
  runtimeIdKey,
  runtimeLayout,
} from "./layout.js";
import {
  LEASE_HEARTBEAT_MS,
  leaseDirectoryFor,
  leaseDirectoryState,
  observeLeaseDirectory,
  removeLeaseDirectory,
  removeLeaseFile,
  removeOrphanLeaseDirectories,
  type LeaseObservation,
} from "./lease.js";
import { isRuntimeId } from "./manifest.js";

export type RuntimeDeferralReason =
  | "retired-recently"
  | "live-lease"
  | "locked"
  | "lease-appeared"
  /** It became `current` or kept between the check and the rename. */
  | "became-kept";

export interface RuntimeDeferral {
  readonly name: string;
  readonly reason: RuntimeDeferralReason;
}

export interface RuntimeCollection {
  readonly removed: readonly string[];
  readonly deferred: readonly RuntimeDeferral[];
  readonly failed: readonly string[];
}

export interface RuntimeCollectionDeps {
  readonly now: () => number;
  readonly monotonic: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly caseInsensitiveIds: boolean;
}

export interface CollectOldRuntimesOptions {
  readonly keep?: readonly string[];
  readonly onlyLeftovers?: boolean;
  readonly remove?: (directory: string) => Promise<void>;
  readonly deps?: Partial<RuntimeCollectionDeps>;
}

interface GcState {
  readonly version: 1;
  readonly retiredAt: Readonly<Record<string, string>>;
  readonly kept?: readonly string[];
}

interface ReadGcState {
  readonly retiredAt: Record<string, string>;
  readonly kept: readonly string[];
  readonly damaged: boolean;
  readonly keptKnown: boolean;
}

interface Candidate {
  readonly name: string;
  readonly first: LeaseObservation;
  readonly observedAt: number;
}

/**
 * A launcher whose lease could not be created (read-only home, Agent sandbox) leaves no proof; seven days since
 * retirement bounds that risk.
 */
export const RETIRED_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const STATE_VERSION = 1;
const MAX_STATE_BYTES = 256 * 1024;
const STATE_MODE = 0o600;
const MAX_KEPT = 8;
const STALE_AFTER_MS = 2 * LEASE_HEARTBEAT_MS;

export const REAL_COLLECTION_DEPS: RuntimeCollectionDeps = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  // An unref'd timer: a collection waiting on a silent lease never keeps the App from quitting.
  sleep: (milliseconds) => delay(milliseconds, undefined, { ref: false }),
  rename: (from, to) => fs.rename(from, to),
  caseInsensitiveIds: IDS_CASE_INSENSITIVE,
};

const removeTree = (directory: string): Promise<void> =>
  fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

function isoTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

function validRuntimeIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === "string" && isRuntimeId(name)).slice(0, MAX_KEPT)
    : [];
}

async function readState(root: string): Promise<ReadGcState> {
  const file = runtimeLayout(root).gcStateFile;
  const damaged: ReadGcState = { retiredAt: {}, kept: [], damaged: true, keptKnown: false };
  // A `leases` that is a link is never read through.
  if ((await leaseDirectoryState(runtimeLayout(root).leasesDirectory)) === "foreign") return damaged;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) return damaged;
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Partial<GcState> | null;
    const retiredAt = raw?.retiredAt;
    if (raw?.version !== STATE_VERSION || typeof retiredAt !== "object" || retiredAt === null) return damaged;
    if (Array.isArray(retiredAt)) return damaged;
    const valid = Object.entries(retiredAt).filter(
      ([name, value]) => isRuntimeId(name) && isoTime(value) !== undefined,
    );
    const kept = validRuntimeIds(raw.kept);
    return {
      retiredAt: Object.fromEntries(valid) as Record<string, string>,
      kept,
      damaged: valid.length < Object.keys(retiredAt).length,
      keptKnown: Array.isArray(raw.kept) && kept.length === raw.kept.length,
    };
  } catch (error) {
    return { retiredAt: {}, kept: [], damaged: errorCode(error) !== "ENOENT", keptKnown: false };
  }
}

const namedKept = new Map<string, readonly string[]>();

async function writeState(root: string, state: GcState): Promise<void> {
  if ((await leaseDirectoryState(runtimeLayout(root).leasesDirectory)) === "foreign") return;
  await writeFileAtomic(runtimeLayout(root).gcStateFile, `${JSON.stringify(state, null, 2)}\n`, {
    mode: STATE_MODE,
  }).catch(() => undefined);
}

async function recordRetirements(
  root: string,
  saved: ReadGcState,
  retired: readonly string[],
  kept: readonly string[],
  now: number,
): Promise<Record<string, string>> {
  const retiredAt: Record<string, string> = {};
  for (const name of retired) retiredAt[name] = saved.retiredAt[name] ?? new Date(now).toISOString();
  const sameRetired =
    Object.keys(saved.retiredAt).length === retired.length &&
    retired.every((name) => saved.retiredAt[name] === retiredAt[name]);
  const sameKept = saved.kept.length === kept.length && kept.every((name, index) => saved.kept[index] === name);
  if (saved.damaged || !sameRetired || !sameKept) await writeState(root, { version: STATE_VERSION, retiredAt, kept });
  return retiredAt;
}

function quarantineRuntimeId(name: string): string | undefined {
  const match = /^\.quarantine-(.+)-[0-9a-f]+$/.exec(name);
  return match?.[1] !== undefined && isRuntimeId(match[1]) ? match[1] : undefined;
}

function uniqueQuarantineName(runtimeId: string): string {
  return `${QUARANTINE_DIRECTORY_PREFIX}${runtimeId}-${randomBytes(4).toString("hex")}`;
}

function hasFreshLease(leases: LeaseObservation, now: number): boolean {
  return [...leases.values()].some((modified) => modified > now - STALE_AFTER_MS);
}

function leasesChanged(first: LeaseObservation, later: LeaseObservation): boolean {
  return [...later].some(([name, modified]) => first.get(name) !== modified);
}

async function waitForSilence(since: number, deps: RuntimeCollectionDeps): Promise<void> {
  for (;;) {
    const remaining = STALE_AFTER_MS - (deps.monotonic() - since);
    if (remaining <= 0) return;
    await deps.sleep(remaining);
  }
}

type CandidateOutcome = { removed: true } | { removed: false; deferral?: RuntimeDeferralReason; failed?: true };

interface CollectionContext {
  readonly root: string;
  readonly remove: (directory: string) => Promise<void>;
  readonly deps: RuntimeCollectionDeps;
  readonly kept: readonly string[];
}

function idSet(ids: readonly (string | undefined)[], deps: RuntimeCollectionDeps): Set<string> {
  return new Set(
    ids.filter((id): id is string => id !== undefined).map((id) => runtimeIdKey(id, deps.caseInsensitiveIds)),
  );
}

/** Read again right before a rename or removal: an install can switch `current` while the collector waits. */
async function isKeptNow(context: CollectionContext, runtimeId: string, requireCurrent: boolean): Promise<boolean> {
  const current = await readCurrentRuntimeId(context.root).catch(() => undefined);
  if (current === undefined && requireCurrent) return true;
  const saved = await readState(context.root);
  return idSet([...context.kept, ...saved.kept, current], context.deps).has(
    runtimeIdKey(runtimeId, context.deps.caseInsensitiveIds),
  );
}

async function collectCandidate(context: CollectionContext, candidate: Candidate): Promise<CandidateOutcome> {
  const { root, remove, deps } = context;
  const leaseDirectory = leaseDirectoryFor(root, candidate.name);
  if (candidate.first.size > 0) {
    await waitForSilence(candidate.observedAt, deps);
    const later = await observeLeaseDirectory(leaseDirectory);
    if (later === undefined || leasesChanged(candidate.first, later)) return { removed: false, deferral: "live-lease" };
  }
  if (await isKeptNow(context, candidate.name, true)) return { removed: false, deferral: "became-kept" };
  const runtimes = path.join(root, RUNTIMES_DIRECTORY_NAME);
  const target = path.join(runtimes, candidate.name);
  const aside = path.join(runtimes, uniqueQuarantineName(candidate.name));
  try {
    await deps.rename(target, aside);
  } catch {
    return { removed: false, deferral: "locked" };
  }
  const after = await observeLeaseDirectory(leaseDirectory);
  if (after === undefined || leasesChanged(candidate.first, after)) {
    try {
      await deps.rename(aside, target);
    } catch {
      return { removed: false, failed: true };
    }
    return { removed: false, deferral: "lease-appeared" };
  }
  try {
    await remove(aside);
  } catch {
    return { removed: false, failed: true };
  }
  await removeLeaseDirectory(leaseDirectory);
  return { removed: true };
}

async function collectLeftover(context: CollectionContext, name: string): Promise<CandidateOutcome | undefined> {
  const { root, remove, deps } = context;
  const id = quarantineRuntimeId(name);
  if (id === undefined) return undefined;
  const runtimes = path.join(root, RUNTIMES_DIRECTORY_NAME);
  const aside = path.join(runtimes, name);
  const kept = await isKeptNow(context, id, false);
  if (kept) return { removed: false, deferral: "live-lease" };
  const leaseDirectory = leaseDirectoryFor(root, id);
  const first = await observeLeaseDirectory(leaseDirectory);
  let live = first === undefined || hasFreshLease(first, deps.now());
  if (!live && first !== undefined && first.size > 0) {
    const observedAt = deps.monotonic();
    await waitForSilence(observedAt, deps);
    const later = await observeLeaseDirectory(leaseDirectory);
    live = later === undefined || leasesChanged(first, later);
  }
  if (live) {
    const target = path.join(runtimes, id);
    const taken = await fs.lstat(target).then(
      () => true,
      () => false,
    );
    if (!taken && first !== undefined) {
      try {
        await deps.rename(aside, target);
        return { removed: false, deferral: "lease-appeared" };
      } catch {
        // Stays quarantined and is tried again.
      }
    }
    return { removed: false, deferral: "live-lease" };
  }
  if (await isKeptNow(context, id, false)) return { removed: false, deferral: "live-lease" };
  try {
    await remove(aside);
  } catch {
    return { removed: false, failed: true };
  }
  return { removed: true };
}

async function pruneKeptLeases(root: string, ids: readonly string[], deps: RuntimeCollectionDeps): Promise<void> {
  const pending: { directory: string; first: LeaseObservation; stale: string[] }[] = [];
  for (const id of ids) {
    const directory = leaseDirectoryFor(root, id);
    const first = await observeLeaseDirectory(directory);
    if (first === undefined) continue;
    const stale = [...first].filter(([, modified]) => modified <= deps.now() - STALE_AFTER_MS).map(([name]) => name);
    if (stale.length > 0) pending.push({ directory, first, stale });
  }
  if (pending.length === 0) return;
  await waitForSilence(deps.monotonic(), deps);
  for (const { directory, first, stale } of pending) {
    const later = await observeLeaseDirectory(directory);
    if (later === undefined) continue;
    for (const name of stale) {
      if (later.get(name) === first.get(name)) await removeLeaseFile(directory, name);
    }
  }
}

export async function collectOldRuntimes(
  root: string,
  options: CollectOldRuntimesOptions = {},
): Promise<RuntimeCollection> {
  const runtimes = path.join(root, RUNTIMES_DIRECTORY_NAME);
  const remove = options.remove ?? removeTree;
  const deps: RuntimeCollectionDeps = { ...REAL_COLLECTION_DEPS, ...options.deps };
  const current = await readCurrentRuntimeId(root).catch(() => undefined);
  const leasesUsable = (await leaseDirectoryState(runtimeLayout(root).leasesDirectory)) !== "foreign";
  const saved = await readState(root);
  const named = options.keep !== undefined && options.keep.length > 0 ? validRuntimeIds(options.keep) : undefined;
  if (named !== undefined) namedKept.set(root, named);
  const remembered = namedKept.get(root);
  const kept = named ?? remembered ?? saved.kept;
  const keptKnown = named !== undefined || remembered !== undefined || saved.keptKnown;
  const keep = idSet([...kept, current], deps);
  const context: CollectionContext = { root, remove, deps, kept };
  let names: string[];
  try {
    names = await fs.readdir(runtimes);
  } catch {
    return { removed: [], deferred: [], failed: [] };
  }
  const removed: string[] = [];
  const deferred: RuntimeDeferral[] = [];
  const failed: string[] = [];
  const retired: string[] = [];
  const leftovers: string[] = [];
  for (const name of names) {
    const target = path.join(runtimes, name);
    const leftover = name.startsWith(QUARANTINE_DIRECTORY_PREFIX);
    const old =
      isRuntimeId(name) &&
      !keep.has(runtimeIdKey(name, deps.caseInsensitiveIds)) &&
      current !== undefined &&
      options.onlyLeftovers !== true;
    if (!leftover && !old) continue;
    try {
      if (!(await fs.lstat(target)).isDirectory()) continue;
      if (old) retired.push(name);
      else leftovers.push(name);
    } catch {
      failed.push(name);
    }
  }
  for (const name of leftovers) {
    if (!leasesUsable) {
      deferred.push({ name, reason: "live-lease" });
      continue;
    }
    try {
      const outcome = await collectLeftover(context, name);
      if (outcome === undefined) continue;
      if (outcome.removed) removed.push(name);
      else if (outcome.deferral === "lease-appeared") {
        deferred.push({ name: quarantineRuntimeId(name) ?? name, reason: outcome.deferral });
      } else if (outcome.deferral !== undefined) deferred.push({ name, reason: outcome.deferral });
      else failed.push(name);
    } catch {
      failed.push(name);
    }
  }
  if (current === undefined || options.onlyLeftovers === true) return { removed, deferred, failed };

  // Without a known kept list the previous runtime looks like an old one: record nothing, so nothing becomes eligible.
  const retiredAt = keptKnown && leasesUsable ? await recordRetirements(root, saved, retired, kept, deps.now()) : {};
  const candidates: Candidate[] = [];
  for (const name of retired) {
    if (!leasesUsable) {
      deferred.push({ name, reason: "live-lease" });
      continue;
    }
    const since = isoTime(retiredAt[name]) ?? deps.now();
    if (deps.now() - since < RETIRED_GRACE_MS) {
      deferred.push({ name, reason: "retired-recently" });
      continue;
    }
    // A link in place of the lease folder is never followed, and then nothing proves the runtime is unused.
    const first = await observeLeaseDirectory(leaseDirectoryFor(root, name));
    if (first === undefined || hasFreshLease(first, deps.now())) {
      deferred.push({ name, reason: "live-lease" });
      continue;
    }
    candidates.push({ name, first, observedAt: deps.monotonic() });
  }
  for (const candidate of candidates) {
    const outcome = await collectCandidate(context, candidate);
    if (outcome.removed) removed.push(candidate.name);
    else if (outcome.deferral !== undefined) deferred.push({ name: candidate.name, reason: outcome.deferral });
    else failed.push(candidate.name);
  }
  if (leasesUsable) {
    await pruneKeptLeases(root, [...new Set([...kept, current])], deps);
    let present = names;
    try {
      present = await fs.readdir(runtimes);
    } catch {
      // The folder went away meanwhile: the names read before still name every id that may hold leases.
    }
    const installed = new Set(
      present.flatMap((name) => {
        const id = quarantineRuntimeId(name) ?? name;
        return isRuntimeId(id) ? [id] : [];
      }),
    );
    await removeOrphanLeaseDirectories(root, installed, deps.caseInsensitiveIds);
  }
  return { removed, deferred, failed };
}
