import { readFile } from "node:fs/promises";
import {
  createStorageRiskClassifier,
  overriddenStorageRisk,
  parseStorageRiskOverride,
  storageRiskFact,
  type StorageRiskResult,
} from "@work-intelligence/desktop-core";
import type { DesktopFacts } from "@work-intelligence/schema";

export interface StorageRiskService {
  /** The verdict for a database path; never rejects (a failed detection is `unknown`). */
  classify(databasePath: string): Promise<StorageRiskResult>;
  /** The last full verdict this run reached for the path, if it was classified. */
  last(databasePath: string): StorageRiskResult | undefined;
  /** The last verdict this run reached for the path as a status-page fact, if it is a risk. */
  fact(databasePath: string): DesktopFacts["storageRisk"];
}

export interface StorageRiskServiceOptions {
  /** A test build's synthetic `prefix -> verdict` file; undefined in every other build. */
  readonly overrideFile?: string | undefined;
  readonly classifier?: (databasePath: string) => Promise<StorageRiskResult>;
  /** The whole classification (path resolution, stat and the mount query) may take this long; then it is `unknown`. */
  readonly timeoutMs?: number;
}

/** A hung `realpath` or `lstat` on a dead network share must not hold a page or a start: the verdict is then `unknown`. */
export const CLASSIFY_TIMEOUT_MS = 5_000;

const unknownResult = (evidence: string): StorageRiskResult => ({
  risk: "unknown",
  evidence: [evidence],
  symlinked: false,
});

/** One classifier for the App run, with the test-build override in front of it. */
export function createStorageRiskService(options: StorageRiskServiceOptions = {}): StorageRiskService {
  const classifier = options.classifier ?? createStorageRiskClassifier();
  const timeoutMs = options.timeoutMs ?? CLASSIFY_TIMEOUT_MS;
  const known = new Map<string, StorageRiskResult>();
  async function detect(databasePath: string): Promise<StorageRiskResult> {
    try {
      const override =
        options.overrideFile === undefined
          ? undefined
          : overriddenStorageRisk(
              databasePath,
              parseStorageRiskOverride(await readFile(options.overrideFile, "utf8").catch(() => "")),
            );
      return override ?? (await classifier(databasePath));
    } catch {
      return unknownResult("classifier-failed");
    }
  }
  async function classify(databasePath: string): Promise<StorageRiskResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<StorageRiskResult>((resolve) => {
      timer = setTimeout(() => resolve(unknownResult("classifier-timeout")), timeoutMs);
    });
    // The late answer of a hung detection is dropped: its verdict was already `unknown`.
    const result = await Promise.race([detect(databasePath), timedOut]).finally(() => clearTimeout(timer));
    known.set(databasePath, result);
    return result;
  }
  return {
    classify,
    last: (databasePath) => known.get(databasePath),
    fact: (databasePath) => storageRiskFact(known.get(databasePath)),
  };
}
