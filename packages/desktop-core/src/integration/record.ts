import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { configDirectory } from "@work-intelligence/shared/database-location";
import { z } from "zod";
import { writeFileAtomic } from "../internal/atomic-file.js";
import { BIN_DIRECTORY_NAME, POSIX_SHIM_NAME, WINDOWS_SHIM_NAME } from "../runtime/layout.js";

export const INTEGRATION_RECORD_VERSION = 1;
export const INTEGRATION_RECORD_FILE_NAME = "desktop-integration.json";

const MAX_PATH_LENGTH = 4096;
const MAX_TEXT_LENGTH = 128;
/** A drive-letter path only: rooted or UNC/device paths can reach a network share (Windows sends NTLM credentials). */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:\\/;
const WINDOWS_VERBATIM_PREFIX = "\\\\?\\";

/**
 * A same-user writer of this record is no new privilege boundary, but it must not widen one: readers refuse anything
 * another user or a network share could control. The dependency-free reader is plugins/work-intelligence/scripts/desktop-integration.mjs.
 */

/** Paths and a version only, never the database path or user data: any process of this user may read it. */
export interface IntegrationRecord {
  readonly version: typeof INTEGRATION_RECORD_VERSION;
  readonly launcherPath: string;
  readonly runtimeRoot: string;
  readonly appExecutable: string;
  readonly appVersion: string;
  readonly writtenAt: string;
}

export type IntegrationRecordInputs = Pick<IntegrationRecord, "runtimeRoot" | "appExecutable" | "appVersion">;

export interface IntegrationDirectoryInputs {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
}

export type IntegrationPublishResult = "written" | "unchanged";

function pathModule(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

export function launcherShimPath(runtimeRoot: string, platform: NodeJS.Platform): string {
  return pathModule(platform).join(
    runtimeRoot,
    BIN_DIRECTORY_NAME,
    platform === "win32" ? WINDOWS_SHIM_NAME : POSIX_SHIM_NAME,
  );
}

export function canonicalInstallationPath(
  value: string,
  platform: NodeJS.Platform,
  realpath: (value: string) => string = realpathSync.native,
): string {
  if (!pathModule(platform).isAbsolute(value)) return value;
  let resolved: string;
  try {
    resolved = realpath(value);
  } catch {
    return value;
  }
  if (platform !== "win32") return resolved;
  if (resolved.startsWith(WINDOWS_VERBATIM_PREFIX)) resolved = resolved.slice(WINDOWS_VERBATIM_PREFIX.length);
  return WINDOWS_DRIVE_PATH.test(resolved) ? resolved : value;
}

export function integrationConfigDirectory({ env, homedir }: IntegrationDirectoryInputs): string {
  return configDirectory({ environment: env, home: homedir });
}

export function integrationRecordPath(inputs: IntegrationDirectoryInputs): string {
  return path.join(integrationConfigDirectory(inputs), INTEGRATION_RECORD_FILE_NAME);
}

/** Strict on purpose; plugins/work-intelligence/scripts/desktop-integration.mjs applies the same rules and tests feed both. */
function recordSchema(platform: NodeJS.Platform) {
  const paths = pathModule(platform);
  const absolute = z
    .string()
    .min(1)
    .max(MAX_PATH_LENGTH)
    .refine(
      (value) =>
        !value.includes("\0") &&
        (platform === "win32" ? WINDOWS_DRIVE_PATH.test(value) : value.startsWith("/")) &&
        paths.normalize(value) === value,
      "not a normalized absolute path",
    );
  return z
    .strictObject({
      version: z.literal(INTEGRATION_RECORD_VERSION),
      launcherPath: absolute,
      runtimeRoot: absolute,
      appExecutable: absolute,
      appVersion: z.string().min(1).max(MAX_TEXT_LENGTH),
      writtenAt: z.string().min(1).max(MAX_TEXT_LENGTH),
    })
    .refine((record) => record.launcherPath === launcherShimPath(record.runtimeRoot, platform), {
      message: "launcherPath is not the shim of runtimeRoot",
      path: ["launcherPath"],
    });
}

export function parseIntegrationRecord(text: string, platform: NodeJS.Platform): IntegrationRecord | undefined {
  try {
    const parsed = recordSchema(platform).safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function readIntegrationRecord(
  file: string,
  platform: NodeJS.Platform,
): Promise<IntegrationRecord | undefined> {
  try {
    return parseIntegrationRecord(await fs.readFile(file, "utf8"), platform);
  } catch {
    return undefined;
  }
}

function sameInstallation(a: IntegrationRecordInputs, b: IntegrationRecordInputs): boolean {
  return a.runtimeRoot === b.runtimeRoot && a.appExecutable === b.appExecutable && a.appVersion === b.appVersion;
}

export async function publishIntegrationRecord(
  file: string,
  inputs: IntegrationRecordInputs,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly now?: () => Date;
    readonly realpath?: (value: string) => string;
  } = {},
): Promise<IntegrationPublishResult> {
  const platform = options.platform ?? process.platform;
  const runtimeRoot = canonicalInstallationPath(inputs.runtimeRoot, platform, options.realpath);
  const record: IntegrationRecord = {
    version: INTEGRATION_RECORD_VERSION,
    launcherPath: launcherShimPath(runtimeRoot, platform),
    runtimeRoot,
    appExecutable: canonicalInstallationPath(inputs.appExecutable, platform, options.realpath),
    appVersion: inputs.appVersion,
    writtenAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  const text = `${JSON.stringify(record, null, 2)}\n`;
  if (parseIntegrationRecord(text, platform) === undefined) {
    throw new RangeError("the desktop integration record would be invalid: paths must be normalized and absolute");
  }
  const existing = await readIntegrationRecord(file, platform);
  if (existing !== undefined && sameInstallation(existing, record)) return "unchanged";
  await writeFileAtomic(file, text);
  return "written";
}
