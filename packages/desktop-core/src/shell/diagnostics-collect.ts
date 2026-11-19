import type { ServiceOwnerState } from "../operations/service-owner-state.js";
import type { LastBackupInfo } from "./last-backup.js";
import type { RecordedError } from "./recent-errors.js";
import type { BackendRunState } from "./repair-state.js";

/** The facts the diagnostics file is made of. Only these fields are read; nothing is copied from anywhere else. */
export interface DiagnosticsInputs {
  readonly platform: NodeJS.Platform;
  readonly appVersion: string;
  /** The random label of this install (settings `installId`). The file shows only its first 8 characters, as `installLabel`: enough to tell that two files come from one install, short enough not to look like the run ids and tokens the redactor masks. */
  readonly installId?: string;
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

/** The diagnostics file as data: a fixed, allow-listed shape. */
export interface DiagnosticsDocument {
  readonly generatedAt: string;
  readonly app: { readonly version: string; readonly installLabel?: string };
  readonly platform: { readonly name: string; readonly arch: string; readonly locale: string };
  readonly state: {
    readonly owner: string;
    readonly backend: string;
    readonly databaseStatus: string;
    readonly lastBackup: LastBackupInfo;
  };
  readonly recentErrors: readonly RecordedError[];
  /** Output lines that were not one of this App's own log lines; dropped, only counted. */
  readonly omittedOutputLines: number;
  readonly recentOutput: readonly string[];
  /** What the size limit removed, oldest first; zeros when nothing was removed. */
  readonly truncated: { readonly outputLines: number; readonly errors: number };
}

/**
 * The prefixes of the lines this App and its backend write themselves (see `main/log.ts`, `apps/server` and the desktop
 * child). The backend's output also holds whatever a dependency or the runtime prints (a stack frame, a SQLite message,
 * a path, a work title); a line that does not start with one of these is not kept.
 */
export const OWN_OUTPUT_PREFIXES: readonly string[] = [
  "[shell] ",
  "[backend] ",
  "[desktop-child] ",
  "[work-intelligence] ",
  "Work Intelligence ",
  "SQLite database: ",
  "Database backup ",
  "Work summary update history pruned: ",
  "History prune failed: ",
];

export function isOwnOutputLine(line: string): boolean {
  return OWN_OUTPUT_PREFIXES.some((prefix) => line.startsWith(prefix));
}

// What follows the fixed text of an own line when something went wrong is detail, and detail can hold work content (an
// error message that names a project, a file, a title). The real lines are `[work-intelligence] API request failed`
// followed by the Error itself (`Error: <message>` / `SqliteError: <message>`, `server.ts`), and `<what> failed:
// <error.message>` (`start-api.ts`, `main/*.ts`). The fixed text stays; the detail goes.
/** An error name or the word "error" followed by a colon: `Error: …`, `TypeError: …`, `Error [ERR_X]: …`, `error: …`. */
const ERROR_DETAIL =
  /(?<![A-Za-z0-9_])(?:[A-Za-z]{0,40}(?:Error|Exception)(?: \[[A-Z0-9_]{1,40}\])?|error)[ \t]{0,3}:/i;
/** `… failed: <detail>`, `… not applied: <detail>`: the label stays, and so does a detail that is a single code or a plain word. */
const LABELLED_DETAIL = /\b(?:failed|failure|not applied|unreadable|refused|rejected)\b[^:\r\n]{0,40}:[ \t]+/i;
/** A detail that cannot hold work content: one reason word or code (`busy`, `invalid`, `unknown error`, `ENOENT`). */
const PLAIN_DETAIL = /^(?:unknown(?: error)?|[a-z][a-z0-9_-]{0,31}|[A-Z][A-Z0-9_]{2,40})$/;
/** The codes worth keeping from a dropped detail: SQLite result codes and system error codes. */
const KEPT_CODE =
  /\b(?:SQLITE_[A-Z0-9_]{1,32}|E(?:NOENT|ACCES|PERM|EXIST|BUSY|ADDRINUSE|CONNREFUSED|CONNRESET|TIMEDOUT|MFILE|NOSPC|NOTDIR|ISDIR|ROFS|XDEV|NOTEMPTY|AGAIN|PIPE|INVAL|IO|NOTFOUND|AI_AGAIN))\b/;

interface CleanedLine {
  readonly line: string;
  readonly droppedDetail: boolean;
}

/** An own line without its error detail: only the fixed text, plus a known error code when the detail held one. */
export function dropErrorDetail(line: string): CleanedLine {
  const firstLine = line.split(/\r?\n/, 1)[0] ?? "";
  let head = firstLine;
  let detail = line.slice(firstLine.length);
  let dropped = detail.trim() !== "";

  const error = ERROR_DETAIL.exec(head);
  if (error) {
    detail += head.slice(error.index);
    head = head.slice(0, error.index).trimEnd();
    dropped = true;
  } else {
    const labelled = LABELLED_DETAIL.exec(head);
    const rest = labelled ? head.slice(labelled.index + labelled[0].length) : "";
    if (labelled && !PLAIN_DETAIL.test(rest.trim())) {
      detail += rest;
      head = head.slice(0, labelled.index + labelled[0].length).trimEnd();
      dropped = true;
    }
  }
  if (!dropped) return { line, droppedDetail: false };
  const code = KEPT_CODE.exec(detail)?.[0];
  return { line: code ? `${head} (${code})` : head, droppedDetail: true };
}

function lastBackupOf(info: LastBackupInfo): LastBackupInfo {
  return info.status === "known" ? { status: "known", at: info.at } : { status: info.status };
}

/** The result of {@link collectDiagnosticsWithStats}: the document and how many own lines lost their error detail. */
export interface CollectedDiagnostics {
  readonly document: DiagnosticsDocument;
  readonly droppedDetails: number;
}

/**
 * Step 1, collect: builds the fixed document from the inputs. It never reads the Agent configuration, MCP inputs or
 * outputs, or the environment: the inputs have no field for them. Each recorded error is copied as its code and time.
 * An own output line keeps its fixed text only: the error detail after it is dropped (see {@link dropErrorDetail}) and
 * counted in `droppedDetails`.
 */
export function collectDiagnosticsWithStats(inputs: DiagnosticsInputs): CollectedDiagnostics {
  const cleaned = inputs.recentOutput.filter(isOwnOutputLine).map(dropErrorDetail);
  const recentOutput = cleaned.map((entry) => entry.line);
  const document: DiagnosticsDocument = {
    generatedAt: inputs.generatedAt.toISOString(),
    app: {
      version: inputs.appVersion,
      ...(inputs.installId ? { installLabel: inputs.installId.replace(/[^0-9a-zA-Z]/g, "").slice(0, 8) } : {}),
    },
    platform: { name: inputs.platform, arch: inputs.arch, locale: inputs.locale },
    state: {
      owner: inputs.owner,
      backend: inputs.backend,
      databaseStatus: inputs.databaseStatus,
      lastBackup: lastBackupOf(inputs.lastBackup),
    },
    recentErrors: inputs.recentErrors.map((entry) => ({ code: entry.code, at: entry.at })),
    omittedOutputLines: inputs.recentOutput.length - recentOutput.length,
    recentOutput,
    truncated: { outputLines: 0, errors: 0 },
  };
  return { document, droppedDetails: cleaned.filter((entry) => entry.droppedDetail).length };
}

export function collectDiagnostics(inputs: DiagnosticsInputs): DiagnosticsDocument {
  return collectDiagnosticsWithStats(inputs).document;
}
