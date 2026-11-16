import { SecretMasker } from "../backend/ring-buffer.js";
import type { ServiceOwnerState } from "../operations/service-owner-state.js";
import type { LastBackupInfo } from "./last-backup.js";
import type { RecordedError } from "./recent-errors.js";
import type { BackendRunState } from "./repair-state.js";

const REDACTED = "[redacted]";

/** A key name that marks its value as a secret. */
const SECRET_KEY = "[A-Za-z0-9_.-]*(?:token|secret|password|passwd|authorization|cookie|api[-_]?key)[A-Za-z0-9_.-]*";

/** `key: value`, `key=value` and `"key": "value"` where the key names a secret; the key stays, the value goes. */
const SECRET_PAIR = new RegExp(
  `((?:\\\\?["'])?${SECRET_KEY}(?:\\\\?["'])?\\s*[:=]\\s*)(\\\\"[^"\\\\]*\\\\"|"(?:[^"\\\\]|\\\\.)*"|'[^']*'|(?:(?:Bearer|Basic|Token)\\s+)?[^\\s,;&"'}\\]\\\\]+)`,
  "gi",
);

/** Well-known token shapes, whatever precedes them. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  // A long unbroken run of URL-safe base64 or hex characters is a key, a run id or a hash, not prose.
  /[A-Za-z0-9_-]{32,}/g,
];

export interface RedactionContext {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly userName?: string;
  /** Database, real database, backup and log paths. */
  readonly paths?: readonly (string | undefined)[];
  /** Exact secrets such as the run id. */
  readonly secrets?: readonly (string | undefined)[];
}

/** JSON writes a backslash twice, so a Windows path inside a JSON string is a different text than the path itself. */
function withJsonEscapedForm(value: string): string[] {
  const escaped = value.replaceAll("\\", "\\\\");
  return escaped === value ? [value] : [value, escaped];
}

/**
 * Builds a function that masks, in any text: the home directory and user name, the known paths (case-insensitive and with
 * either slash on Windows), exact secrets, then secret-looking values by key name and well-known token shapes.
 * Plain string search for the known values; the patterns are fixed and never built from input.
 */
export function createRedactor(context: RedactionContext): (text: string) => string {
  const masker = new SecretMasker({ caseInsensitive: context.platform === "win32" });
  const known = [context.homeDirectory, context.userName, ...(context.paths ?? []), ...(context.secrets ?? [])];
  for (const value of known) {
    if (!value) continue;
    for (const form of withJsonEscapedForm(value)) masker.add(form);
  }
  return (text) => {
    let result = masker.apply(text);
    result = result.replace(SECRET_PAIR, (_match, key: string) => `${key}${REDACTED}`);
    for (const pattern of TOKEN_PATTERNS)
      result = result.replace(pattern, (match) =>
        match.startsWith("Bearer") || match.startsWith("bearer") ? `Bearer ${REDACTED}` : REDACTED,
      );
    return result;
  };
}

export interface DiagnosticsInputs extends RedactionContext {
  readonly appVersion: string;
  readonly arch: string;
  readonly locale: string;
  readonly owner: ServiceOwnerState;
  readonly backend: BackendRunState;
  readonly databaseStatus: string;
  readonly recentErrors: readonly RecordedError[];
  readonly lastBackup: LastBackupInfo;
  readonly recentOutput: readonly string[];
  readonly generatedAt: Date;
}

/** The text of the diagnostics file: JSON, with every known path and secret masked. */
export function buildDiagnostics(inputs: DiagnosticsInputs): string {
  const redact = createRedactor(inputs);
  const document = {
    generatedAt: inputs.generatedAt.toISOString(),
    app: { version: inputs.appVersion },
    platform: { name: inputs.platform, arch: inputs.arch, locale: inputs.locale },
    state: {
      owner: inputs.owner,
      backend: inputs.backend,
      databaseStatus: inputs.databaseStatus,
      lastBackup: inputs.lastBackup,
    },
    recentErrors: inputs.recentErrors,
    recentOutput: inputs.recentOutput,
  };
  return redact(`${JSON.stringify(document, null, 2)}\n`);
}
