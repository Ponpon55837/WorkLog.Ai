import { isDeepStrictEqual } from "node:util";
import type { DatabaseIdentityRecord } from "../db-source/identity-schema.js";
import type { DesktopSettingsV1 } from "../settings/schema.js";

/**
 * Falling back to the last combination that worked (the settings' `lastKnownGood`), for exactly what can be verified.
 *
 * - **Port.** A start that failed because its port is taken (or not allowed) may run on the port the last verified start
 *   used. The start is verified like every start (health, identity), the user's own choice in `desired.port` is not changed,
 *   and the Status tab says which port runs instead and why.
 * - **Database.** Never replaced automatically: another file would show other data. A database that cannot start goes to the
 *   repair flow, which lists the databases found.
 * - **Runtime.** The existing single verified reinstall of the bundled runtime applies; an older runtime is not switched back.
 *
 * A fallback that fails too ends in the repair flow with the original error. Nothing here writes or moves data.
 */

/** The failures that a different port can fix; a port still held by the previous run (`PORT_NOT_RELEASED`) only needs a wait. */
const PORT_FAILURE_CODES: ReadonlySet<string> = new Set(["PORT_OCCUPIED_BY_OTHER", "PORT_NOT_PERMITTED"]);

export interface StartupFallbackInputs {
  readonly failureCode: string;
  /** The port the failed start used. */
  readonly attemptedPort: number;
  readonly lastKnownGood: DesktopSettingsV1["lastKnownGood"];
  /** Only one fallback per start; a failed one is never repeated. */
  readonly alreadyTried: boolean;
}

export interface PortFallbackPlan {
  readonly port: number;
  /** The App version that last ran there: shown, and compared with the running one for the explanation. */
  readonly runtimeVersion: string;
}

/** The port to try instead, or null when no fallback applies. */
export function planPortFallback(inputs: StartupFallbackInputs): PortFallbackPlan | null {
  if (inputs.alreadyTried || !PORT_FAILURE_CODES.has(inputs.failureCode) || !inputs.lastKnownGood) return null;
  if (inputs.lastKnownGood.port === inputs.attemptedPort) return null;
  return { port: inputs.lastKnownGood.port, runtimeVersion: inputs.lastKnownGood.runtimeVersion };
}

/** Whether the database the fallback start verified is the one the last good start ran (the combination is the same). */
export function sameAsLastKnownGood(
  lastKnownGood: DesktopSettingsV1["lastKnownGood"],
  started: DatabaseIdentityRecord,
): boolean {
  return lastKnownGood ? isDeepStrictEqual(lastKnownGood.databaseIdentity, started) : false;
}

/** What the Status tab tells about a fallback of this App run. */
export type StartupFallbackNote =
  | {
      readonly kind: "port-restored";
      /** The port the settings name (it stays what the user chose). */
      readonly wantedPort: number;
      /** The port the service runs on now. */
      readonly usedPort: number;
      readonly code: string;
      readonly runtimeVersion: string;
      /** The verified database is the one that last ran there. */
      readonly sameDatabase: boolean;
    }
  | {
      readonly kind: "port-failed";
      readonly wantedPort: number;
      readonly triedPort: number;
      readonly code: string;
    };
