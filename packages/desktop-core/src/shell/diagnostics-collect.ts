import type { ServiceOwnerState } from "../operations/service-owner-state.js";
import type { LastBackupInfo } from "./last-backup.js";
import type { RecordedError } from "./recent-errors.js";
import type { BackendRunState } from "./repair-state.js";

export interface DiagnosticsInputs {
  readonly platform: NodeJS.Platform;
  readonly appVersion: string;
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
  readonly mcpLease?: McpLeaseDiagnosticsInput;
}

export interface McpLeaseDiagnosticsInput {
  readonly backendScopeId: string;
  readonly backendDirectoryWritable: boolean;
  readonly activeLeases: number;
  readonly agentObserved: boolean;
  readonly observedScopeId?: string;
  readonly observedDirectoryWritable?: boolean;
  readonly cause?: string;
}

interface McpLeaseDiagnostics {
  readonly backendScope: string;
  readonly backendDirectoryWritable: boolean;
  readonly activeLeases: number;
  readonly agentObserved: boolean;
  readonly observedScope?: string;
  readonly observedDirectoryWritable?: boolean;
  readonly scopesMatch?: boolean;
  readonly cause?: string;
}

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
  readonly mcpLease?: McpLeaseDiagnostics;
  readonly recentErrors: readonly RecordedError[];
  readonly omittedOutputLines: number;
  readonly recentOutput: readonly string[];
  readonly truncated: { readonly outputLines: number; readonly errors: number };
}

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

const ERROR_DETAIL =
  /(?<![A-Za-z0-9_])(?:[A-Za-z]{0,40}(?:Error|Exception)(?: \[[A-Z0-9_]{1,40}\])?|error)[ \t]{0,3}:/i;
const LABELLED_DETAIL = /\b(?:failed|failure|not applied|unreadable|refused|rejected)\b[^:\r\n]{0,40}:[ \t]+/i;
const PLAIN_DETAIL = /^(?:unknown(?: error)?|[a-z][a-z0-9_-]{0,31}|[A-Z][A-Z0-9_]{2,40})$/;
const KEPT_CODE =
  /\b(?:SQLITE_[A-Z0-9_]{1,32}|E(?:NOENT|ACCES|PERM|EXIST|BUSY|ADDRINUSE|CONNREFUSED|CONNRESET|TIMEDOUT|MFILE|NOSPC|NOTDIR|ISDIR|ROFS|XDEV|NOTEMPTY|AGAIN|PIPE|INVAL|IO|NOTFOUND|AI_AGAIN))\b/;

interface CleanedLine {
  readonly line: string;
  readonly droppedDetail: boolean;
}

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

const SCOPE_LABEL_LENGTH = 8;

function mcpLeaseOf(input: McpLeaseDiagnosticsInput): McpLeaseDiagnostics {
  const label = (id: string): string => id.replace(/[^0-9a-f]/g, "").slice(0, SCOPE_LABEL_LENGTH);
  return {
    backendScope: label(input.backendScopeId),
    backendDirectoryWritable: input.backendDirectoryWritable,
    activeLeases: Math.max(0, Math.trunc(input.activeLeases)),
    agentObserved: input.agentObserved,
    ...(input.observedScopeId === undefined
      ? {}
      : { observedScope: label(input.observedScopeId), scopesMatch: input.observedScopeId === input.backendScopeId }),
    ...(input.observedDirectoryWritable === undefined
      ? {}
      : { observedDirectoryWritable: input.observedDirectoryWritable }),
    ...(input.cause && /^[a-z_]{1,32}$/.test(input.cause) ? { cause: input.cause } : {}),
  };
}

export interface CollectedDiagnostics {
  readonly document: DiagnosticsDocument;
  readonly droppedDetails: number;
}

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
    ...(inputs.mcpLease ? { mcpLease: mcpLeaseOf(inputs.mcpLease) } : {}),
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
