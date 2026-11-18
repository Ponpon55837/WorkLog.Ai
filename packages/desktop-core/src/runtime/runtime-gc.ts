import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
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

/** Why a runtime was not removed this time; it is tried again later. */
export type RuntimeDeferralReason =
  | "retired-recently"
  | "live-lease"
  | "locked"
  | "lease-appeared"
  /** It became `current` or kept between the check and the rename. */
  | "became-kept";

/** A runtime that stays for now. */
export interface RuntimeDeferral {
  readonly name: string;
  readonly reason: RuntimeDeferralReason;
}

/** What a collection did; names only, never paths. */
export interface RuntimeCollection {
  readonly removed: readonly string[];
  /** Runtimes that are not yet provably unused (see {@link collectOldRuntimes}); tried again next time. */
  readonly deferred: readonly RuntimeDeferral[];
  /** Directories that could not be removed now (on Windows, one a running process still holds); tried again next time. */
  readonly failed: readonly string[];
}

/** The clocks and file operations of a collection; injectable so tests need no real time or lock. */
export interface RuntimeCollectionDeps {
  /** Wall-clock milliseconds: when a runtime was first seen retired, and how old a lease's modification time is. */
  readonly now: () => number;
  /** Monotonic milliseconds (`performance.now`): the proof that a lease was not renewed uses this, not the wall clock. */
  readonly monotonic: () => number;
  /** Waits; the real one uses a timer that does not keep the process alive. */
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** Moves a runtime directory aside (and back). A refusal is how a Windows file lock shows. */
  readonly rename: (from: string, to: string) => Promise<void>;
  /** Whether runtime ids that differ only in case are the same runtime (Windows, macOS); injectable for tests. */
  readonly caseInsensitiveIds: boolean;
}

/** Options of {@link collectOldRuntimes}. */
export interface CollectOldRuntimesOptions {
  /**
   * Runtime ids to keep besides `current`: the previous runtime is the one fallback. When given, it is remembered in the
   * launcher root, and an empty or missing list keeps what was remembered.
   */
  readonly keep?: readonly string[];
  /** Remove only leftovers (quarantined directories), never a runtime directory. */
  readonly onlyLeftovers?: boolean;
  /** Removes a directory tree; injectable so tests can make one stay. */
  readonly remove?: (directory: string) => Promise<void>;
  readonly deps?: Partial<RuntimeCollectionDeps>;
}

/**
 * The record in {@link GC_STATE_FILE_NAME}: when each runtime that is neither current nor kept was first seen retired,
 * and `kept`, the fallback runtimes the last install named, so that a later start that does not know them still keeps them.
 */
interface GcState {
  readonly version: 1;
  readonly retiredAt: Readonly<Record<string, string>>;
  readonly kept?: readonly string[];
}

/** {@link GcState} as read: `damaged` when the file existed but was oversized, foreign or malformed (the next write replaces it). */
interface ReadGcState {
  readonly retiredAt: Record<string, string>;
  readonly kept: readonly string[];
  readonly damaged: boolean;
  /** Whether the record named its kept runtimes (an empty list included); false when it is missing, damaged or has no such list. */
  readonly keptKnown: boolean;
}

/** A runtime that passed the retirement check and now needs the proof of no live connection. */
interface Candidate {
  readonly name: string;
  readonly first: LeaseObservation;
  /** The monotonic time of the first observation. */
  readonly observedAt: number;
}

/**
 * How long a runtime must have been retired (neither current nor previous) before it can be collected. A launcher whose
 * lease could not be created (an Agent sandbox with a read-only home) leaves no proof, but every new launch goes through
 * `current`, so such a process must have started before its runtime was retired twice. Seven days since the retirement
 * bounds the remaining risk to a lease-less process that has run for more than seven days from a runtime two or more
 * versions old.
 */
export const RETIRED_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const STATE_VERSION = 1;
const MAX_STATE_BYTES = 256 * 1024;
const STATE_MODE = 0o600;
const MAX_KEPT = 8;
/** A lease untouched for this long, and not renewed while the collector waited as long again, is a crash leftover. */
const STALE_AFTER_MS = 2 * LEASE_HEARTBEAT_MS;

const REAL_DEPS: RuntimeCollectionDeps = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  sleep: (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds).unref();
    }),
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

/**
 * Saves the record atomically, owner-only; best effort (without it a runtime is simply seen as retired again next
 * time). Nothing is written when `leases` is a link, so the file never lands wherever the link points.
 */
async function writeState(root: string, state: GcState): Promise<void> {
  if ((await leaseDirectoryState(runtimeLayout(root).leasesDirectory)) === "foreign") return;
  await writeFileAtomic(runtimeLayout(root).gcStateFile, `${JSON.stringify(state, null, 2)}\n`, {
    mode: STATE_MODE,
  }).catch(() => undefined);
}

/**
 * Notes when each of `retired` was first seen retired, remembers `kept`, and forgets runtimes that are no longer retired
 * or no longer on disk. Rewrites the file only when its content changes: it lives in the leases folder, so it never changes the launcher root's
 * change time (the Windows ACL stamp covers that); it is still written only on change. Returns the retirement times.
 */
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

/**
 * The runtime id inside a quarantine directory name, `.quarantine-<id>-<hex>`, or `undefined` when the name does not
 * have that shape (then it is not ours and is left alone). Runtime ids may contain hyphens, so only the last hyphen
 * separates the random suffix.
 */
function quarantineRuntimeId(name: string): string | undefined {
  const match = /^\.quarantine-(.+)-[0-9a-f]+$/.exec(name);
  return match?.[1] !== undefined && isRuntimeId(match[1]) ? match[1] : undefined;
}

function uniqueQuarantineName(runtimeId: string): string {
  return `${QUARANTINE_DIRECTORY_PREFIX}${runtimeId}-${randomBytes(4).toString("hex")}`;
}

/** Whether a lease was touched recently enough that its process may still be alive. */
function hasFreshLease(leases: LeaseObservation, now: number): boolean {
  return [...leases.values()].some((modified) => modified > now - STALE_AFTER_MS);
}

/** Whether `later` shows a lease that was not in `first`, or one whose modification time moved (it was renewed). */
function leasesChanged(first: LeaseObservation, later: LeaseObservation): boolean {
  return [...later].some(([name, modified]) => first.get(name) !== modified);
}

/** Waits until the monotonic clock has advanced {@link STALE_AFTER_MS} since `since`; the timers do not keep the process alive. */
async function waitForSilence(since: number, deps: RuntimeCollectionDeps): Promise<void> {
  for (;;) {
    const remaining = STALE_AFTER_MS - (deps.monotonic() - since);
    if (remaining <= 0) return;
    await deps.sleep(remaining);
  }
}

type CandidateOutcome = { removed: true } | { removed: false; deferral?: RuntimeDeferralReason; failed?: true };

/** What a collection pass needs besides the launcher root. */
interface CollectionContext {
  readonly root: string;
  readonly remove: (directory: string) => Promise<void>;
  readonly deps: RuntimeCollectionDeps;
  /** The kept ids known when the collection began (named by the caller or remembered); `current` is added when read. */
  readonly kept: readonly string[];
}

function idSet(ids: readonly (string | undefined)[], deps: RuntimeCollectionDeps): Set<string> {
  return new Set(
    ids.filter((id): id is string => id !== undefined).map((id) => runtimeIdKey(id, deps.caseInsensitiveIds)),
  );
}

/**
 * Reads `current` and the remembered kept list again, right before something is renamed or removed, because an install
 * can switch `current` while the collector waits. `runtimeId` is then kept when it is current, remembered or given.
 * With `requireCurrent`, a `current` that cannot be read also counts as kept: nothing is renamed without knowing it.
 */
async function isKeptNow(context: CollectionContext, runtimeId: string, requireCurrent: boolean): Promise<boolean> {
  const current = await readCurrentRuntimeId(context.root).catch(() => undefined);
  if (current === undefined && requireCurrent) return true;
  const saved = await readState(context.root);
  return idSet([...context.kept, ...saved.kept, current], context.deps).has(
    runtimeIdKey(runtimeId, context.deps.caseInsensitiveIds),
  );
}

/**
 * Removes the old runtime `candidate` if nothing can be using it, else says why not. The proof:
 * 1. Its leases are all older than twice the heartbeat, and stay exactly as they were while the collector's own
 *    monotonic clock advanced twice the heartbeat: a live process renews its lease every heartbeat, so these leases belong
 *    to processes that died without removing them. No process id is consulted.
 * 2. `current` is read again: the runtime did not become current or kept while the collector waited.
 * 3. The directory is renamed aside. On Windows a running executable or a handle without share-delete makes that fail
 *    (`locked`); on every platform the process that finds its directory gone cannot go on.
 * 4. The leases are read again: a launcher that began between the check and the rename leaves a new lease, and then the
 *    directory is renamed back (`lease-appeared`). If it cannot be renamed back it stays as a quarantined directory,
 *    which the next collection treats with the same proof (see {@link collectLeftover}).
 */
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

/**
 * Removes the quarantined directory `.quarantine-<id>-<hex>` only with the proof a runtime needs (DT-24), never on its
 * name alone: it may be a runtime renamed back unsuccessfully after a launcher began (a live process uses it), or a
 * directory an install set aside because a process may still run from it. The proof, for the id in the name:
 * - the id is not current or kept (a kept id is never removed, its quarantined copy waits until it is retired);
 * - `leases/<id>` has no fresh lease and, when it has leases at all, none changed while the collector's monotonic clock
 *   advanced twice the heartbeat (same silence check as for a runtime);
 * - `current` and the kept list are read again right before the removal.
 * A quarantine that fails the lease proof and whose runtime name is free is renamed back first (the rename-back that
 * failed earlier is tried again); a kept id is never renamed back here, because an install in progress sets its own
 * quarantine aside while its target is briefly free.
 *
 * The seven-day retirement period is deliberately not applied again: a quarantine made by this collector was renamed
 * only after its runtime had been retired that long, and one made by an install holds the same id the install just
 * replaced, whose live processes are covered by `leases/<id>` as for any runtime. A name that does not carry a valid id
 * is not ours and is left alone.
 */
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

/**
 * Removes the lease files of kept runtimes (`current`, the previous one) that are proven dead: older than twice the
 * heartbeat and unchanged while the monotonic clock advanced twice the heartbeat. Only regular `.lease` files are
 * unlinked (checked with `lstat`, a link is never followed); the kept runtime's directory and fresh leases are untouched.
 */
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

/**
 * Collects `<root>/runtimes` (DT-24, ADR-16): removes quarantined directories that pass the proof in
 * {@link collectLeftover} (a staging directory belongs to an install that may be running, so only that install removes it)
 * and old runtime directories that are provably unused.
 *
 * `current` and the `keep` runtimes (the previous one is the fallback) are never removed; `current` is read here, at
 * collection time, and if it cannot be read nothing but leftovers is removed. Any other runtime is first recorded as
 * retired (see {@link RETIRED_GRACE_MS}) and becomes eligible once it has been retired that long; then the proof in
 * `collectCandidate` must hold, else the runtime is `deferred` with the reason. When no kept list is known (the record is
 * missing, damaged or unwritable and the caller named none), nothing is recorded and nothing becomes eligible: the
 * previous runtime cannot be told from an old one. If `<root>/leases` is not a real directory (a link), no lease work
 * is done and every runtime that is not kept is deferred as `live-lease`. A directory that cannot be removed stays
 * and is reported in `failed`. Neither is an error: install never waits on this, and the caller tries again later.
 * Lease directories of runtimes that no longer exist are removed too, and stale leases of kept runtimes are pruned.
 * Run it in the background: it can wait for several minutes to prove a lease was not renewed. It is meant to run from
 * the App that holds the single-instance lock.
 */
export async function collectOldRuntimes(
  root: string,
  options: CollectOldRuntimesOptions = {},
): Promise<RuntimeCollection> {
  const runtimes = path.join(root, RUNTIMES_DIRECTORY_NAME);
  const remove = options.remove ?? removeTree;
  const deps: RuntimeCollectionDeps = { ...REAL_DEPS, ...options.deps };
  const current = await readCurrentRuntimeId(root).catch(() => undefined);
  const leasesUsable = (await leaseDirectoryState(runtimeLayout(root).leasesDirectory)) !== "foreign";
  const saved = await readState(root);
  // An install names the fallback runtime; a later start does not know it, so the last one named is kept in the record.
  const named = options.keep !== undefined && options.keep.length > 0 ? validRuntimeIds(options.keep) : undefined;
  const kept = named ?? saved.kept;
  const keptKnown = named !== undefined || saved.keptKnown;
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
    // A quarantined directory still holds its runtime's leases as proof: its id counts as installed.
    const present = await fs.readdir(runtimes).catch(() => names);
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
