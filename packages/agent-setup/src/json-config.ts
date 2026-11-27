import { JSON_OBJECT, displayPath, readRegularFile } from "./files.js";
import type { JsonMutationSpec, ManagedEntry } from "./types.js";
import { entryIndex, removeEntry, setEntry } from "./manifest.js";

export function equalValue(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (JSON_OBJECT(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function getPathValue(root: Record<string, unknown>, path: readonly string[]): unknown {
  let value: unknown = root;
  for (const key of path) {
    if (!JSON_OBJECT(value)) return undefined;
    value = value[key];
  }
  return value;
}

export function setPathValue(root: Record<string, unknown>, path: readonly string[], value: unknown): boolean {
  let current = root;
  for (const key of path.slice(0, -1)) {
    if (current[key] === undefined) current[key] = {};
    if (!JSON_OBJECT(current[key])) return false;
    current = current[key];
  }
  const last = path.at(-1);
  if (!last) return false;
  current[last] = value;
  return true;
}

export function deletePathValue(root: Record<string, unknown>, path: readonly string[]): boolean {
  let current: unknown = root;
  for (const key of path.slice(0, -1)) {
    if (!JSON_OBJECT(current)) return false;
    current = current[key];
  }
  const last = path.at(-1);
  if (!last || !JSON_OBJECT(current)) return false;
  delete current[last];
  return true;
}

export function sameManagedHookShape(actual: unknown, expected: unknown, key?: string): boolean {
  if (key === "command" && typeof actual === "string" && typeof expected === "string") return true;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length < expected.length) return false;
    const unmatched = [...actual];
    for (const expectedItem of expected) {
      const match = unmatched.findIndex((actualItem) => sameManagedHookShape(actualItem, expectedItem));
      if (match < 0) return false;
      unmatched.splice(match, 1);
    }
    return true;
  }
  if (JSON_OBJECT(actual) || JSON_OBJECT(expected)) {
    if (!JSON_OBJECT(actual) || !JSON_OBJECT(expected)) return false;
    return Object.keys(expected).every(
      (childKey) => childKey in actual && sameManagedHookShape(actual[childKey], expected[childKey], childKey),
    );
  }
  return equalValue(actual, expected);
}

function singleHookParts(expected: unknown): { rest: Record<string, unknown>; hook: unknown } | undefined {
  if (!JSON_OBJECT(expected) || !Array.isArray(expected.hooks) || expected.hooks.length !== 1) return undefined;
  const { hooks, ...rest } = expected;
  return { rest, hook: hooks[0] };
}

export function findOwnedHook(
  array: readonly unknown[],
  expected: unknown,
): { groupIndex: number; hookIndex: number } | undefined {
  const parts = singleHookParts(expected);
  if (!parts) return undefined;
  for (const [groupIndex, group] of array.entries()) {
    if (!JSON_OBJECT(group) || !Array.isArray(group.hooks)) continue;
    const { hooks, ...rest } = group;
    if (!equalValue(rest, parts.rest)) continue;
    const hookIndex = hooks.findIndex((hook) => equalValue(hook, parts.hook));
    if (hookIndex >= 0) return { groupIndex, hookIndex };
  }
  return undefined;
}

function removeOwnedHook(array: unknown[], location: { groupIndex: number; hookIndex: number }): void {
  const group = array[location.groupIndex];
  if (!JSON_OBJECT(group) || !Array.isArray(group.hooks)) return;
  group.hooks.splice(location.hookIndex, 1);
  if (group.hooks.length === 0 && Object.keys(group).every((key) => key === "matcher" || key === "hooks")) {
    array.splice(location.groupIndex, 1);
  }
}

export function parseJsonFile(
  path: string,
  homeDirectory: string,
  conflicts: string[],
): { root: Record<string, unknown>; before: Buffer | null; mode: number } {
  const read = readRegularFile(path);
  if (read.conflict) conflicts.push(read.conflict);
  if (!read.bytes) return { root: {}, before: null, mode: read.mode };
  try {
    const value: unknown = JSON.parse(read.bytes.toString("utf8"));
    if (!JSON_OBJECT(value)) throw new Error("expected object");
    return { root: value, before: read.bytes, mode: read.mode };
  } catch {
    conflicts.push(`${displayPath(path, homeDirectory)} 不是受支援的 JSON object，保留且拒絕修改。`);
    return { root: {}, before: read.bytes, mode: read.mode };
  }
}

function jsonIndent(source: Buffer | null): string {
  if (!source) return "  ";
  const match = /\n([ \t]+)"/.exec(source.toString("utf8"));
  return match?.[1] ?? "  ";
}

// Keeps the file's indentation, line endings and trailing newline; a new file ends with one.
export function serializeJson(root: Record<string, unknown>, source: Buffer | null): Buffer {
  const text = source?.toString("utf8");
  const newline = text?.includes("\r\n") ? "\r\n" : "\n";
  const ending = text === undefined || text.trim() === "" || /\n\s*$/.test(text) ? newline : "";
  return Buffer.from(JSON.stringify(root, null, jsonIndent(source)).replaceAll("\n", newline) + ending, "utf8");
}

export function addJsonSpec(
  root: Record<string, unknown>,
  entries: ManagedEntry[],
  spec: JsonMutationSpec,
  conflicts: string[],
  actions: string[],
): boolean {
  const previousIndex = entryIndex(entries, spec.id);
  const previous = previousIndex >= 0 ? entries[previousIndex] : undefined;
  let changed = false;
  if (spec.kind === "property") {
    const current = getPathValue(root, spec.path);
    if (current === undefined) {
      if (!setPathValue(root, spec.path, spec.expected)) {
        conflicts.push(`${spec.label} 的設定結構不受支援，保留且拒絕修改。`);
        return false;
      }
      setEntry(entries, { id: spec.id as "claudeMcp", kind: "json-property", expected: spec.expected });
      return true;
    }
    if (equalValue(current, spec.expected)) {
      if (previous?.kind === "json-property" && !equalValue(previous.expected, spec.expected)) {
        setEntry(entries, { ...previous, expected: spec.expected });
      }
      return false;
    }
    if (previous?.kind === "json-property" && equalValue(current, previous.expected)) {
      // An adopted hand-written entry already points at the target and keeps its own extra keys.
      if (previous.adopted && spec.equivalent?.(current)) return false;
      setPathValue(root, spec.path, spec.expected);
      setEntry(entries, { id: spec.id as "claudeMcp", kind: "json-property", expected: spec.expected });
      return true;
    }
    if (spec.equivalent?.(current)) {
      actions.push(`保留既有 ${spec.label}：已指向這個 Work Intelligence，不修改。`);
      return false;
    }
    const upgraded = spec.upgrade?.(current);
    if (upgraded !== undefined) {
      setPathValue(root, spec.path, upgraded);
      actions.push(`更新既有 ${spec.label}：改用 MCP launcher，建置更新後不必重新連線；其餘自訂設定保留。`);
      return true;
    }
    conflicts.push(`${spec.label} 已有不同設定，保留且拒絕覆寫。`);
    return changed;
  }

  const arrayKey = spec.path.at(-1);
  if (getPathValue(root, spec.path) === undefined) {
    if (!setPathValue(root, spec.path, [])) {
      conflicts.push(`${spec.label} 的設定結構不受支援，保留且拒絕修改。`);
      return false;
    }
  }
  const array = getPathValue(root, spec.path);
  if (!Array.isArray(array)) {
    conflicts.push(`${spec.label} 不是陣列，保留且拒絕修改。`);
    return false;
  }
  const exact = array.findIndex((item) => equalValue(item, spec.expected));
  if (exact >= 0) {
    if (previous?.kind === "json-array-item" && !equalValue(previous.expected, spec.expected)) {
      setEntry(entries, { ...previous, expected: spec.expected });
    }
    return false;
  }
  if (previous?.kind === "json-array-item") {
    // An adopted hook that shares its group with the user's own hooks stays exactly as it is.
    if (previous.adopted && !array.some((item) => equalValue(item, previous.expected))) {
      if (findOwnedHook(array, previous.expected)) return false;
    }
    const ownedIndex = array.findIndex((item) => equalValue(item, previous.expected));
    if (ownedIndex >= 0) {
      if (previous.adopted && spec.similar?.(array[ownedIndex])) return false;
      array.splice(ownedIndex, 1, spec.expected);
      setEntry(entries, {
        id: spec.id as ManagedEntry["id"],
        kind: "json-array-item",
        expected: spec.expected,
      } as ManagedEntry);
      return true;
    }
    if (array.some((item) => sameManagedHookShape(item, previous.expected))) {
      conflicts.push(`${spec.label} 已在安裝後修改；保留現有 hook 並拒絕新增重複項目。`);
      return false;
    }
  }
  if (spec.equivalent && array.some(spec.equivalent)) {
    actions.push(`保留既有 ${spec.label}：已指向這個 Work Intelligence，不修改。`);
    return false;
  }
  const upgradeIndex = spec.upgrade ? array.findIndex((item) => spec.upgrade?.(item) !== undefined) : -1;
  if (spec.upgrade && upgradeIndex >= 0) {
    array[upgradeIndex] = spec.upgrade(array[upgradeIndex]);
    actions.push(`更新既有 ${spec.label} 的 matcher，其餘自訂設定保留。`);
    return true;
  }
  if (arrayKey && spec.similar && array.some(spec.similar)) {
    conflicts.push(`${spec.label} 有已自訂的相似設定，保留且拒絕新增重複項目。`);
    return false;
  }
  array.push(spec.expected);
  actions.push(`加入 ${spec.label}。`);
  setEntry(entries, {
    id: spec.id as ManagedEntry["id"],
    kind: "json-array-item",
    expected: spec.expected,
  } as ManagedEntry);
  changed = true;
  return changed;
}

export function removeJsonSpec(
  root: Record<string, unknown>,
  entries: ManagedEntry[],
  entry: ManagedEntry,
  path: readonly string[],
  similar?: (value: unknown) => boolean,
  conflicts: string[] = [],
  label: string = entry.id,
): boolean {
  if (entry.kind === "json-property") {
    const current = getPathValue(root, path);
    if (current === undefined) {
      removeEntry(entries, entry.id);
      return false;
    }
    if (equalValue(current, entry.expected)) {
      deletePathValue(root, path);
      removeEntry(entries, entry.id);
      return true;
    }
    conflicts.push(`${label} 已在安裝後變更；保留現有設定與安裝紀錄。`);
    return false;
  }
  if (entry.kind !== "json-array-item") return false;
  const value = getPathValue(root, path);
  if (!Array.isArray(value)) {
    if (value === undefined) {
      removeEntry(entries, entry.id);
      return false;
    }
    conflicts.push(`${label} 的陣列結構已變更；保留現有設定與安裝紀錄。`);
    return false;
  }
  const index = value.findIndex((item) => equalValue(item, entry.expected));
  if (index >= 0) {
    value.splice(index, 1);
    removeEntry(entries, entry.id);
    return true;
  }
  const owned = entry.adopted ? findOwnedHook(value, entry.expected) : undefined;
  if (owned) {
    removeOwnedHook(value, owned);
    removeEntry(entries, entry.id);
    return true;
  }
  if (value.some((item) => sameManagedHookShape(item, entry.expected))) {
    conflicts.push(`${label} 已在安裝後修改；保留該 hook 與安裝紀錄。`);
    return false;
  }
  if (similar && value.some(similar)) {
    conflicts.push(`${label} 已在安裝後修改；保留該 hook 與安裝紀錄。`);
    return false;
  }
  removeEntry(entries, entry.id);
  return false;
}
