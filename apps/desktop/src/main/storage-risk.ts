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
}

/** One classifier for the App run, with the test-build override in front of it. */
export function createStorageRiskService(options: StorageRiskServiceOptions = {}): StorageRiskService {
  const classifier = options.classifier ?? createStorageRiskClassifier();
  const known = new Map<string, StorageRiskResult>();
  async function classify(databasePath: string): Promise<StorageRiskResult> {
    let result: StorageRiskResult;
    try {
      const override =
        options.overrideFile === undefined
          ? undefined
          : overriddenStorageRisk(
              databasePath,
              parseStorageRiskOverride(await readFile(options.overrideFile, "utf8").catch(() => "")),
            );
      result = override ?? (await classifier(databasePath));
    } catch {
      result = { risk: "unknown", evidence: ["classifier-failed"], symlinked: false };
    }
    known.set(databasePath, result);
    return result;
  }
  return {
    classify,
    last: (databasePath) => known.get(databasePath),
    fact: (databasePath) => storageRiskFact(known.get(databasePath)),
  };
}
