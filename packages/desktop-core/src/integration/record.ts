import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../internal/atomic-file.js";
import { BIN_DIRECTORY_NAME, POSIX_SHIM_NAME, WINDOWS_SHIM_NAME } from "../runtime/layout.js";

/** The only schema version; a reader that finds another one ignores the record instead of guessing. */
export const INTEGRATION_RECORD_VERSION = 1;
/** The record's file name inside the Work Intelligence config directory, next to `plugin-link.json`. */
export const INTEGRATION_RECORD_FILE_NAME = "desktop-integration.json";

const MAX_PATH_LENGTH = 4096;
const MAX_TEXT_LENGTH = 128;
/** A drive-letter or UNC path; a rooted path without a drive depends on the current drive and is never accepted. */
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:\\|\\\\)/;

/**
 * What the packaged App tells Agents about itself: where the fixed launcher shim is and which executable is the App.
 * It holds paths and a version only, never the database path or any user data, so any process of this user may read it.
 */
export interface IntegrationRecord {
  readonly version: typeof INTEGRATION_RECORD_VERSION;
  /** The shim at `<runtimeRoot>/bin/work-intelligence-launcher[.cmd]`; always exactly that path. */
  readonly launcherPath: string;
  readonly runtimeRoot: string;
  /** The App's own executable, started with `--open-dashboard` (OPEN_DASHBOARD_FLAG) to open the Dashboard. */
  readonly appExecutable: string;
  readonly appVersion: string;
  /** ISO time of the last write; informational only, never compared. */
  readonly writtenAt: string;
}

/** What identifies an installation: the record is rewritten only when one of these changes. */
export type IntegrationRecordInputs = Pick<IntegrationRecord, "runtimeRoot" | "appExecutable" | "appVersion">;

/** Inputs of {@link integrationConfigDirectory}; everything comes from the caller so the function is pure. */
export interface IntegrationDirectoryInputs {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
}

/** `written`: the record changed, `unchanged` the file already said this. */
export type IntegrationPublishResult = "written" | "unchanged";

function pathModule(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/** The shim path for a runtime root; the one value `launcherPath` may have. */
export function launcherShimPath(runtimeRoot: string, platform: NodeJS.Platform): string {
  return pathModule(platform).join(
    runtimeRoot,
    BIN_DIRECTORY_NAME,
    platform === "win32" ? WINDOWS_SHIM_NAME : POSIX_SHIM_NAME,
  );
}

/** `WORK_INTELLIGENCE_CONFIG_DIR`, else `~/.work-intelligence`: the directory the plugin reads `plugin-link.json` from. */
export function integrationConfigDirectory({ env, homedir }: IntegrationDirectoryInputs): string {
  return env.WORK_INTELLIGENCE_CONFIG_DIR?.trim() || path.join(homedir, ".work-intelligence");
}

/** The record's path inside {@link integrationConfigDirectory}. */
export function integrationRecordPath(inputs: IntegrationDirectoryInputs): string {
  return path.join(integrationConfigDirectory(inputs), INTEGRATION_RECORD_FILE_NAME);
}

/**
 * Strict on purpose: another version, a missing or extra field, a relative or non-normalized path (`..` segments) and a
 * launcher path other than `<runtimeRoot>/bin/<shim>` all invalidate the record. plugins/work-intelligence/scripts/
 * desktop-integration.mjs applies the same rules without dependencies (tests keep the two in agreement).
 */
function recordSchema(platform: NodeJS.Platform) {
  const paths = pathModule(platform);
  const absolute = z
    .string()
    .min(1)
    .max(MAX_PATH_LENGTH)
    .refine(
      (value) =>
        !value.includes("\0") &&
        (platform === "win32" ? WINDOWS_ABSOLUTE_PATH.test(value) : value.startsWith("/")) &&
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

/** The record in `text`, or undefined when it is not JSON or breaks any rule of the schema. */
export function parseIntegrationRecord(text: string, platform: NodeJS.Platform): IntegrationRecord | undefined {
  try {
    const parsed = recordSchema(platform).safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The record stored in `file`, or undefined when it is missing, unreadable or invalid. */
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

/**
 * Writes the record for this installation, atomically, unless the file already says the same: a warm start reads
 * a few hundred bytes and writes nothing. Throws when the inputs would make an invalid record (a relative path) or the
 * file cannot be written; the caller treats that as "no integration", never as a start failure.
 */
export async function publishIntegrationRecord(
  file: string,
  inputs: IntegrationRecordInputs,
  options: { readonly platform?: NodeJS.Platform; readonly now?: () => Date } = {},
): Promise<IntegrationPublishResult> {
  const platform = options.platform ?? process.platform;
  const record: IntegrationRecord = {
    version: INTEGRATION_RECORD_VERSION,
    launcherPath: launcherShimPath(inputs.runtimeRoot, platform),
    ...inputs,
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
