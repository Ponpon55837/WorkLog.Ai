import { join } from "node:path";
import {
  collectOldRuntimes,
  ensureBundledRuntime,
  runtimeErrorCode,
  type BundledRuntimeStatus,
  type EnsuredRuntime,
  type RuntimeCollection,
  type ShellErrorCode,
} from "@work-intelligence/desktop-core";
import type { DesktopPaths } from "./config.js";
import type { Logger } from "./log.js";

export interface RuntimeProvisionerOptions {
  readonly packaged: boolean;
  readonly paths: Pick<DesktopPaths, "runtimeRoot">;
  /** `process.resourcesPath`. */
  readonly resourcesPath: string;
  readonly log: Logger;
}

export interface RuntimeProvisioner {
  /**
   * Makes the bundled runtime current in the packaged App; does nothing otherwise (a development or smoke run uses the
   * runtime root from the test environment). Calls overlap safely: they run one after another.
   * `verifyInstalled` also verifies (through the fingerprint cache) a runtime that looks current, for a retry after the
   * backend refused it. Resolves with what was done (`undefined` when nothing is provisioned). Throws a
   * {@link RuntimeProvisionError}.
   */
  prepare(verifyInstalled: boolean): Promise<BundledRuntimeStatus | undefined>;
}

/** Folder inside the App's resources that holds the bundled runtime (`current` and `runtimes/<id>/`). */
export const BUNDLE_DIRECTORY_NAME = "runtime-bundle";

/** Waits before each retry of a collection that deferred something; after the last one it retries hourly. */
const RETRY_DELAYS_MS: readonly number[] = [10 * 60_000, 30 * 60_000];
const RETRY_HOURLY_MS = 60 * 60_000;

/** Runtime errors the repair page explains in their own words; every other failure reads as "could not be prepared". */
const OWN_CODES: ReadonlySet<string> = new Set([
  "RUNTIME_UNSAFE_PERMISSIONS",
  "RUNTIME_ACL_UNREADABLE",
  "RUNTIME_IN_USE",
]);

/** The runtime could not be prepared; `code` is the repair page's error code. */
export class RuntimeProvisionError extends Error {
  readonly code: ShellErrorCode;

  constructor(code: ShellErrorCode, reason: string, options?: { cause?: unknown }) {
    super(`${code}: ${reason}`, options);
    this.name = "RuntimeProvisionError";
    this.code = code;
  }
}

/**
 * ` acl=<tier> <ms> ms` (plus ` acl-failed=<tier> <ms> ms` per tier that failed first), ` acl-prewarm=<ms> ms` when the
 * answering read ran in a PowerShell started during the copy, and ` acl-reads=<n>` when the ACLs were read; else empty.
 * `acl=` is the wait the install actually had for the answer: with a prewarm it starts when the files are in place, so
 * the start-up cost that overlapped the copy is `acl-prewarm=` (spawn to first output) and not part of `acl=`.
 */
function describeAclRead(ensured: Pick<EnsuredRuntime, "aclReport" | "aclReads">): string {
  const { aclReport: report } = ensured;
  if (report === undefined) return "";
  const failed = report.attempts.filter((attempt) => !attempt.ok);
  const answered = report.attempts.find((attempt) => attempt.ok);
  return [
    ...failed.map((attempt) => ` acl-failed=${attempt.tier} ${attempt.ms} ms`),
    ` acl=${report.tier} ${answered?.ms} ms`,
    ...(report.prewarmMs === undefined ? [] : [` acl-prewarm=${report.prewarmMs} ms`]),
    ` acl-reads=${ensured.aclReads}`,
  ].join("");
}

/**
 * Whether a collection that left something behind is worth trying again while the App runs. A runtime retired a moment
 * ago waits for its grace period, which hours of retries would not shorten: the next start collects it (L-12). Only a
 * lease that may still be live, or a directory that is locked, can clear up by itself.
 * @internal test-only
 */
export function worthRetrying(result: Pick<RuntimeCollection, "deferred" | "failed">): boolean {
  return result.failed.length > 0 || result.deferred.some((entry) => entry.reason !== "retired-recently");
}

export function createRuntimeProvisioner(options: RuntimeProvisionerOptions): RuntimeProvisioner {
  let queue: Promise<unknown> = Promise.resolve();
  let collections: Promise<unknown> = Promise.resolve();
  let retryTimer: NodeJS.Timeout | undefined;
  /** Bumped by every new collection; a result of an older one schedules no retry. */
  let generation = 0;

  /**
   * Cleanup is a background job: it never delays a start. A runtime that stays (not yet provably unused, or locked on
   * Windows) is tried again after 10 min, 30 min and then hourly while the App runs, on a timer that does not keep it alive;
   * a new collection cancels the pending retry. Collections run one after another: one can wait minutes to prove a lease
   * was not renewed.
   */
  function collectInBackground(keep: readonly string[], retries = 0): void {
    if (retries === 0) {
      generation += 1;
      clearTimeout(retryTimer);
    }
    const mine = generation;
    collections = collections.then(() =>
      collectOldRuntimes(options.paths.runtimeRoot, { keep })
        .then((result) => {
          if (result.removed.length > 0 || result.deferred.length > 0 || result.failed.length > 0) {
            options.log(
              `[shell] runtime cleanup removed=${result.removed.length} deferred=${result.deferred.length} kept-locked=${result.failed.length}`,
            );
          }
          if (mine !== generation || !worthRetrying(result)) return;
          const delay = RETRY_DELAYS_MS[retries] ?? RETRY_HOURLY_MS;
          retryTimer = setTimeout(() => collectInBackground(keep, retries + 1), delay);
          retryTimer.unref();
        })
        .catch(() => undefined),
    );
  }

  async function run(verifyInstalled: boolean): Promise<BundledRuntimeStatus | undefined> {
    if (!options.packaged) return undefined;
    try {
      const ensured = await ensureBundledRuntime(
        options.paths.runtimeRoot,
        join(options.resourcesPath, BUNDLE_DIRECTORY_NAME),
        {
          expectedManifestSha256: __WI_BUNDLED_RUNTIME_SHA256__,
          requiredRuntimeKind: "node",
          verifyInstalled,
        },
      );
      options.log(
        `[shell] runtime ${ensured.status} ${ensured.runtimeId} in ${ensured.elapsedMs} ms${describeAclRead(ensured)}`,
      );
      collectInBackground(ensured.previousRuntimeId ? [ensured.previousRuntimeId] : []);
      return ensured.status;
    } catch (error) {
      // Codes only: the message of a runtime error carries paths.
      const reason = runtimeErrorCode(error);
      options.log(`[shell] runtime install failed: ${reason ?? "unexpected error"}`);
      throw new RuntimeProvisionError(
        reason !== undefined && OWN_CODES.has(reason) ? (reason as ShellErrorCode) : "RUNTIME_INSTALL_FAILED",
        reason ?? "unexpected error",
        { cause: error },
      );
    }
  }

  return {
    prepare: (verifyInstalled) => {
      const next = queue.then(() => run(verifyInstalled));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
