/** Values that look like secrets are masked on every line shown, before and after. */
import type { AgentSetupPlan } from "./types.js";

export type AgentSetupDiffLineType = "context" | "add" | "remove" | "note";

export interface AgentSetupDiffLine {
  type: AgentSetupDiffLineType;
  text: string;
}

export interface AgentSetupDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: AgentSetupDiffLine[];
}

export interface AgentSetupMutationDescription {
  path: string;
  label: string;
  change: "create" | "update" | "delete";
  hunks: AgentSetupDiffHunk[];
  tooLarge: boolean;
}

type EditKind = "equal" | "remove" | "add";

interface Edit {
  kind: EditKind;
  oldIndex: number;
  newIndex: number;
}

const CONTEXT_LINES = 2;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINES = 20_000;
// Above this the LCS table is skipped and the changed middle shows as one removal and one addition.
const MAX_LCS_CELLS = 16_000_000;
const TOO_LARGE_NOTE = "檔案過大，無法顯示差異";
const MASK = "***";
// The suffixes match a whole trailing word: `API_KEY` and `SIGNING_KEY` match, `MONKEY_MODE` and `KEY_PATH` do not.
const SECRET_KEY =
  /token|secret|password|passwd|api[_-]?key|authorization|bearer|cookie|credential|private[_-]?key|database[_-]?url|(?:^|[_-])(?:key|pat|dsn)$/i;
const BEARER_VALUE = /\bBearer\s+[^\s"'\\,;]+/gi;
const KEY_VALUE = /("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.-]+)(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,}\]#"']+)/g;
const QUERY_PARAM = /([?&])([A-Za-z0-9_.-]+)=([^&\s"'\\#]+)/g;
const FLAG_EQUALS = /(--[A-Za-z0-9][A-Za-z0-9_-]*)=([^\s"'\\,;]+)/g;
const FLAG_SPACE = /(--[A-Za-z0-9][A-Za-z0-9_-]*)(\s+)([^\s"'\\,;-][^\s"'\\,;]*)/g;
const FLAG_ELEMENT = /(["']--[A-Za-z0-9][A-Za-z0-9_-]*["']\s*,\s*)("(?:[^"\\]|\\.)*"|'[^']*')/g;
const TRAILING_FLAG = /["'](--[A-Za-z0-9][A-Za-z0-9_-]*)["']\s*,?\s*$/;

function isSecretFlag(flag: string): boolean {
  return SECRET_KEY.test(flag.slice(2));
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function keyName(token: string): string {
  return token.startsWith('"') || token.startsWith("'") ? token.slice(1, -1) : token;
}

function bracketBalance(line: string): number {
  let balance = 0;
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#") break;
    else if (char === "{" || char === "[") balance += 1;
    else if (char === "}" || char === "]") balance -= 1;
  }
  return balance;
}

function maskLines(lines: readonly string[]): string[] {
  const masked: string[] = [];
  let hidingDepth = 0;
  let flagValueNext = false;
  for (const line of lines) {
    if (hidingDepth > 0) {
      hidingDepth += bracketBalance(line);
      masked.push(line.replace(/\S.*$/, MASK));
      continue;
    }
    let working = line;
    if (flagValueNext) working = working.replace(/("(?:[^"\\]|\\.)*"|'[^']*')/, `"${MASK}"`);
    flagValueNext = TRAILING_FLAG.test(line) && isSecretFlag(TRAILING_FLAG.exec(line)?.[1] ?? "");
    let opened = 0;
    const withoutBearer = working
      .replace(BEARER_VALUE, (match) => match.replace(/\S+$/, MASK))
      .replace(QUERY_PARAM, (match, lead: string, key: string) =>
        SECRET_KEY.test(key) ? `${lead}${key}=${MASK}` : match,
      )
      .replace(FLAG_EQUALS, (match, flag: string) => (isSecretFlag(flag) ? `${flag}=${MASK}` : match))
      .replace(FLAG_SPACE, (match, flag: string, gap: string) => (isSecretFlag(flag) ? `${flag}${gap}${MASK}` : match))
      .replace(FLAG_ELEMENT, (match, lead: string) => {
        const flag = /--[A-Za-z0-9][A-Za-z0-9_-]*/.exec(lead)?.[0] ?? "";
        return isSecretFlag(flag) ? `${lead}"${MASK}"` : match;
      });
    const result = withoutBearer.replace(
      KEY_VALUE,
      (match, key: string, separator: string, value: string, offset: number) => {
        if (!SECRET_KEY.test(keyName(key))) return match;
        if (value === "[" || value === "{") {
          opened = Math.max(opened, bracketBalance(withoutBearer.slice(offset + key.length + separator.length)));
        }
        return `${key}${separator}${MASK}`;
      },
    );
    masked.push(result);
    hidingDepth = opened;
  }
  return masked;
}

function diffMiddle(oldLines: readonly string[], newLines: readonly string[], prefix: number): Edit[] {
  const edits: Edit[] = [];
  const rows = oldLines.length;
  const columns = newLines.length;
  if (rows === 0 || columns === 0 || (rows + 1) * (columns + 1) > MAX_LCS_CELLS) {
    for (let index = 0; index < rows; index += 1)
      edits.push({ kind: "remove", oldIndex: prefix + index, newIndex: -1 });
    for (let index = 0; index < columns; index += 1)
      edits.push({ kind: "add", oldIndex: -1, newIndex: prefix + index });
    return edits;
  }
  const width = columns + 1;
  const table = new Uint16Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[row * width + column] =
        oldLines[row] === newLines[column]
          ? (table[(row + 1) * width + column + 1] ?? 0) + 1
          : Math.max(table[(row + 1) * width + column] ?? 0, table[row * width + column + 1] ?? 0);
    }
  }
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (oldLines[row] === newLines[column]) {
      edits.push({ kind: "equal", oldIndex: prefix + row, newIndex: prefix + column });
      row += 1;
      column += 1;
    } else if ((table[(row + 1) * width + column] ?? 0) >= (table[row * width + column + 1] ?? 0)) {
      edits.push({ kind: "remove", oldIndex: prefix + row, newIndex: -1 });
      row += 1;
    } else {
      edits.push({ kind: "add", oldIndex: -1, newIndex: prefix + column });
      column += 1;
    }
  }
  for (; row < rows; row += 1) edits.push({ kind: "remove", oldIndex: prefix + row, newIndex: -1 });
  for (; column < columns; column += 1) edits.push({ kind: "add", oldIndex: -1, newIndex: prefix + column });
  return edits;
}

function editScript(oldLines: readonly string[], newLines: readonly string[]): Edit[] {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const edits: Edit[] = [];
  for (let index = 0; index < prefix; index += 1) edits.push({ kind: "equal", oldIndex: index, newIndex: index });
  edits.push(
    ...diffMiddle(
      oldLines.slice(prefix, oldLines.length - suffix),
      newLines.slice(prefix, newLines.length - suffix),
      prefix,
    ),
  );
  for (let index = suffix; index > 0; index -= 1) {
    edits.push({ kind: "equal", oldIndex: oldLines.length - index, newIndex: newLines.length - index });
  }
  return edits;
}

function buildHunks(
  edits: readonly Edit[],
  oldShown: readonly string[],
  newShown: readonly string[],
): AgentSetupDiffHunk[] {
  const changed = edits.flatMap((edit, index) => (edit.kind === "equal" ? [] : [index]));
  const hunks: AgentSetupDiffHunk[] = [];
  let groupStart = 0;
  while (groupStart < changed.length) {
    let groupEnd = groupStart;
    while (
      groupEnd + 1 < changed.length &&
      (changed[groupEnd + 1] ?? 0) - (changed[groupEnd] ?? 0) - 1 <= CONTEXT_LINES * 2
    ) {
      groupEnd += 1;
    }
    const from = Math.max(0, (changed[groupStart] ?? 0) - CONTEXT_LINES);
    const to = Math.min(edits.length - 1, (changed[groupEnd] ?? 0) + CONTEXT_LINES);
    const lines: AgentSetupDiffLine[] = [];
    let oldCount = 0;
    let newCount = 0;
    let oldStart = 0;
    let newStart = 0;
    for (let index = from; index <= to; index += 1) {
      const edit = edits[index];
      if (!edit) continue;
      if (edit.kind !== "add") {
        if (oldCount === 0) oldStart = edit.oldIndex + 1;
        oldCount += 1;
      }
      if (edit.kind !== "remove") {
        if (newCount === 0) newStart = edit.newIndex + 1;
        newCount += 1;
      }
      lines.push({
        type: edit.kind === "equal" ? "context" : edit.kind,
        text: edit.kind === "add" ? (newShown[edit.newIndex] ?? "") : (oldShown[edit.oldIndex] ?? ""),
      });
    }
    hunks.push({ oldStart, oldLines: oldCount, newStart, newLines: newCount, lines });
    groupStart = groupEnd + 1;
  }
  return hunks;
}

function describeOne(
  before: Buffer | null,
  after: Buffer | null,
): Pick<AgentSetupMutationDescription, "hunks" | "tooLarge"> {
  if ((before?.length ?? 0) > MAX_BYTES || (after?.length ?? 0) > MAX_BYTES) return tooLarge();
  const oldLines = splitLines(before?.toString("utf8") ?? "");
  const newLines = splitLines(after?.toString("utf8") ?? "");
  if (oldLines.length > MAX_LINES || newLines.length > MAX_LINES) return tooLarge();
  return {
    hunks: buildHunks(editScript(oldLines, newLines), maskLines(oldLines), maskLines(newLines)),
    tooLarge: false,
  };
}

function tooLarge(): Pick<AgentSetupMutationDescription, "hunks" | "tooLarge"> {
  return {
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, lines: [{ type: "note", text: TOO_LARGE_NOTE }] }],
    tooLarge: true,
  };
}

export function describeAgentSetupMutations(plan: Pick<AgentSetupPlan, "mutations">): AgentSetupMutationDescription[] {
  return plan.mutations.map((mutation) => ({
    path: mutation.path,
    label: mutation.label,
    change: mutation.before === null ? "create" : mutation.after === null ? "delete" : "update",
    ...describeOne(mutation.before, mutation.after),
  }));
}
