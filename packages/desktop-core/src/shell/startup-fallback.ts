import { isDeepStrictEqual } from "node:util";
import type { DatabaseIdentityRecord } from "../db-source/identity-schema.js";
import type { DesktopSettingsV1 } from "../settings/schema.js";

const PORT_FAILURE_CODES: ReadonlySet<string> = new Set(["PORT_OCCUPIED_BY_OTHER", "PORT_NOT_PERMITTED"]);

export interface StartupFallbackInputs {
  readonly failureCode: string;
  readonly attemptedPort: number;
  readonly lastKnownGood: DesktopSettingsV1["lastKnownGood"];
  readonly alreadyTried: boolean;
}

export interface PortFallbackPlan {
  readonly port: number;
  readonly runtimeVersion: string;
}

export function planPortFallback(inputs: StartupFallbackInputs): PortFallbackPlan | null {
  if (inputs.alreadyTried || !PORT_FAILURE_CODES.has(inputs.failureCode) || !inputs.lastKnownGood) return null;
  if (inputs.lastKnownGood.port === inputs.attemptedPort) return null;
  return { port: inputs.lastKnownGood.port, runtimeVersion: inputs.lastKnownGood.runtimeVersion };
}

export function sameAsLastKnownGood(
  lastKnownGood: DesktopSettingsV1["lastKnownGood"],
  started: DatabaseIdentityRecord,
): boolean {
  return lastKnownGood ? isDeepStrictEqual(lastKnownGood.databaseIdentity, started) : false;
}

export type StartupFallbackNote =
  | {
      readonly kind: "port-restored";
      readonly wantedPort: number;
      readonly usedPort: number;
      readonly code: string;
      readonly runtimeVersion: string;
      readonly sameDatabase: boolean;
    }
  | {
      readonly kind: "port-failed";
      readonly wantedPort: number;
      readonly triedPort: number;
      readonly code: string;
    };
