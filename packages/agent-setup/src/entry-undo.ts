import { basename, dirname, resolve } from "node:path";
import { MANIFEST_FILENAME, TOML_BLOCK_END, TOML_BLOCK_START } from "./constants.js";
import { JSON_OBJECT, fingerprintOf, readCurrent, removeAtomically, sha256, writeAtomically } from "./files.js";
import { getClaudeHookSpecs, getClaudeMcpSpec, getCodexHookSpecs } from "./hook-specs.js";
import { equalValue, getPathValue, removeJsonSpec, serializeJson } from "./json-config.js";
import { parseManifest } from "./manifest.js";
import { normalizePlanOptions, targetPath } from "./paths.js";
import type { AgentSetupPlanOptions, ManagedEntry } from "./types.js";

export interface EntryUndoItem {
  readonly path: string;
  readonly mode: number;
  readonly beforeFingerprint: string;
}

export interface EntryUndoManifestItem {
  readonly path: string;
  readonly loadBefore: () => Buffer | null;
}

export type EntryUndoOutcome = "restored" | "unsafe";

function comparable(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function ownedEntriesFor(
  item: EntryUndoItem,
  manifestItem: EntryUndoManifestItem,
): { entries: ManagedEntry[]; options: AgentSetupPlanOptions } | undefined {
  const current = parseManifest(readCurrent(manifestItem.path));
  const before = parseManifest(manifestItem.loadBefore());
  if (current.conflict || before.conflict) return undefined;
  const homeDirectory = dirname(manifestItem.path);
  const options = normalizePlanOptions({
    homeDirectory,
    repositoryRoot: homeDirectory,
    codexHomeDirectory: current.manifest.codexHomeDirectory ?? before.manifest.codexHomeDirectory,
    claudeConfigDirectory: current.manifest.claudeConfigDirectory ?? before.manifest.claudeConfigDirectory,
  });
  const onThisFile = (entry: ManagedEntry): boolean =>
    comparable(targetPath(entry.id, options)) === comparable(item.path);
  // An owned entry gone from the manifest means this was an uninstall: nothing of ours to take out.
  if (
    before.manifest.components.some(
      (entry) => onThisFile(entry) && !current.manifest.components.some((c) => c.id === entry.id),
    )
  ) {
    return undefined;
  }
  const entries: ManagedEntry[] = [];
  for (const entry of current.manifest.components.filter(onThisFile)) {
    const prior = before.manifest.components.find((candidate) => candidate.id === entry.id);
    if (prior && equalValue(prior, entry)) continue;
    // The earlier form of a replaced or adopted entry is only in the backup.
    if (prior || entry.adopted) return undefined;
    entries.push(entry);
  }
  return entries.length > 0 ? { entries, options } : undefined;
}

function pruneEmpty(root: Record<string, unknown>, path: readonly string[]): void {
  for (let depth = path.length; depth > 0; depth -= 1) {
    const parentPath = path.slice(0, depth - 1);
    const key = path[depth - 1];
    const parent = parentPath.length === 0 ? root : getPathValue(root, parentPath);
    if (key === undefined || !JSON_OBJECT(parent)) return;
    const value = parent[key];
    const empty = Array.isArray(value) ? value.length === 0 : JSON_OBJECT(value) && Object.keys(value).length === 0;
    if (!empty) return;
    delete parent[key];
  }
}

function jsonSpecFor(entry: ManagedEntry, options: AgentSetupPlanOptions) {
  if (entry.id === "claudeMcp") return getClaudeMcpSpec(options);
  const platform = options.platform ?? process.platform;
  return [...getClaudeHookSpecs(options, platform), ...getCodexHookSpecs(options, platform)].find(
    (spec) => spec.id === entry.id,
  );
}

function undoJson(item: EntryUndoItem, entries: ManagedEntry[], options: AgentSetupPlanOptions): EntryUndoOutcome {
  const bytes = readCurrent(item.path);
  if (bytes === null) return "unsafe";
  let root: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!JSON_OBJECT(parsed)) return "unsafe";
    root = parsed;
  } catch {
    return "unsafe";
  }
  const paths: (readonly string[])[] = [];
  let changed = false;
  for (const entry of entries) {
    const spec = jsonSpecFor(entry, options);
    if (!spec) return "unsafe";
    const conflicts: string[] = [];
    changed = removeJsonSpec(root, [...entries], entry, spec.path, spec.similar, conflicts, spec.label) || changed;
    if (conflicts.length > 0) return "unsafe";
    paths.push(spec.path);
  }
  if (!changed) return "unsafe";
  if (item.beforeFingerprint === "absent") for (const path of paths) pruneEmpty(root, path);
  const createdByUs = item.beforeFingerprint === "absent" && Object.keys(root).length === 0;
  const next = createdByUs ? null : serializeJson(root, bytes);
  const expected = fingerprintOf(bytes);
  if (next === null) removeAtomically(item.path, expected);
  else writeAtomically(item.path, next, item.mode, expected);
  const after = readCurrent(item.path);
  if (after === null) return next === null ? "restored" : "unsafe";
  try {
    const reread: unknown = JSON.parse(after.toString("utf8"));
    if (!JSON_OBJECT(reread)) return "unsafe";
    for (const entry of entries) {
      const spec = jsonSpecFor(entry, options);
      if (!spec) return "unsafe";
      const value = getPathValue(reread, spec.path);
      const stillThere =
        entry.kind === "json-property"
          ? value !== undefined && equalValue(value, entry.expected)
          : Array.isArray(value) && value.some((candidate) => equalValue(candidate, entry.expected));
      if (stillThere) return "unsafe";
    }
  } catch {
    return "unsafe";
  }
  return "restored";
}

function undoToml(item: EntryUndoItem, entry: Extract<ManagedEntry, { kind: "toml-block" }>): EntryUndoOutcome {
  const bytes = readCurrent(item.path);
  if (bytes === null) return "unsafe";
  const text = bytes.toString("utf8");
  const open = text.split(TOML_BLOCK_START).length - 1;
  const close = text.split(TOML_BLOCK_END).length - 1;
  if (open !== 1 || close !== 1 || !text.includes(entry.expected)) return "unsafe";
  const next = text.replace(entry.expected, "");
  const createdByUs = item.beforeFingerprint === "absent" && next.trim() === "";
  const expected = fingerprintOf(bytes);
  if (createdByUs) removeAtomically(item.path, expected);
  else writeAtomically(item.path, Buffer.from(next, "utf8"), item.mode, expected);
  const after = readCurrent(item.path);
  return after === null || !after.toString("utf8").includes(TOML_BLOCK_START) ? "restored" : "unsafe";
}

function undoFile(item: EntryUndoItem, entry: Extract<ManagedEntry, { kind: "file" }>): EntryUndoOutcome {
  const bytes = readCurrent(item.path);
  if (bytes === null) return "unsafe";
  if (sha256(bytes) !== entry.expected) return "unsafe";
  removeAtomically(item.path, fingerprintOf(bytes));
  return "restored";
}

// All or nothing per file: what cannot be removed without guessing is `unsafe` and nothing is written.
export function undoOwnedEntries(
  item: EntryUndoItem,
  manifestItem: EntryUndoManifestItem | undefined,
): EntryUndoOutcome {
  if (!manifestItem || basename(item.path) === MANIFEST_FILENAME) return "unsafe";
  try {
    const owned = ownedEntriesFor(item, manifestItem);
    if (!owned) return "unsafe";
    const first = owned.entries[0];
    if (!first) return "unsafe";
    if (first.kind === "file") return owned.entries.length === 1 ? undoFile(item, first) : "unsafe";
    if (first.kind === "toml-block") return owned.entries.length === 1 ? undoToml(item, first) : "unsafe";
    return undoJson(item, owned.entries, owned.options);
  } catch {
    return "unsafe";
  }
}
