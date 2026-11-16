import { join } from "node:path";
import {
  collectOldRuntimes,
  ensureBundledRuntime,
  runtimeErrorCode,
  type BundledRuntimeStatus,
  type EnsuredRuntime,
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

/** Runtime errors the repair page explains in their own words; every other failure reads as "could not be prepared". */
const OWN_CODES: ReadonlySet<string> = new Set(["RUNTIME_UNSAFE_PERMISSIONS", "RUNTIME_ACL_UNREADABLE"]);

/** The runtime could not be prepared; `code` is the repair page's error code. */
export class RuntimeProvisionError extends Error {
  readonly code: ShellErrorCode;

  constructor(code: ShellErrorCode, reason: string, options?: { cause?: unknown }) {
    super(`${code}: ${reason}`, options);
    this.name = "RuntimeProvisionError";
    this.code = code;
  }
}

/** ` acl=<tier> <ms> ms` (plus ` acl-failed=<tier> <ms> ms` per tier that failed first) when the ACLs were read; else empty. */
function describeAclRead(report: EnsuredRuntime["aclReport"]): string {
  if (report === undefined) return "";
  const failed = report.attempts.filter((attempt) => !attempt.ok);
  const answered = report.attempts.find((attempt) => attempt.ok);
  return [
    ...failed.map((attempt) => ` acl-failed=${attempt.tier} ${attempt.ms} ms`),
    ` acl=${report.tier} ${answered?.ms} ms`,
  ].join("");
}

export function createRuntimeProvisioner(options: RuntimeProvisionerOptions): RuntimeProvisioner {
  let queue: Promise<unknown> = Promise.resolve();

  /** Cleanup is a background job: it never delays a start, and a directory that stays is tried again next time. */
  function collectInBackground(keep: readonly string[], onlyLeftovers: boolean): void {
    void collectOldRuntimes(options.paths.runtimeRoot, { keep, onlyLeftovers })
      .then((result) => {
        if (result.removed.length > 0 || result.failed.length > 0) {
          options.log(`[shell] runtime cleanup removed=${result.removed.length} kept-locked=${result.failed.length}`);
        }
      })
      .catch(() => undefined);
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
        `[shell] runtime ${ensured.status} ${ensured.runtimeId} in ${ensured.elapsedMs} ms${describeAclRead(ensured.aclReport)}`,
      );
      const fresh = ensured.status !== "already-current";
      collectInBackground(ensured.previousRuntimeId ? [ensured.previousRuntimeId] : [], !fresh);
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
