import { join } from "node:path";
import { JSON_OBJECT } from "./files.js";
import { MANIFEST_FILENAME } from "./constants.js";
import type { AgentSetupComponentId, HookComponentId, ManagedEntry, SetupManifest } from "./types.js";

const HOOK_COMPONENT_IDS: ReadonlySet<AgentSetupComponentId> = new Set<HookComponentId>([
  "claudeStopHook",
  "claudePreCompactHook",
  "claudePreToolUseHook",
  "claudeSessionStartHook",
  "codexPostToolUseHook",
  "codexStopHook",
  "codexUserPromptSubmitHook",
  "codexPreToolUseHook",
  "codexSessionStartHook",
]);

export function manifestPath(homeDirectory: string): string {
  return join(homeDirectory, MANIFEST_FILENAME);
}

export function parseManifest(bytes: Buffer | null): { manifest: SetupManifest; conflict?: string } {
  if (!bytes) {
    return { manifest: { version: 2, components: [] } };
  }
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      !JSON_OBJECT(parsed) ||
      (parsed.version !== 1 && parsed.version !== 2) ||
      !Array.isArray(parsed.components) ||
      (parsed.codexHomeDirectory !== undefined && typeof parsed.codexHomeDirectory !== "string") ||
      (parsed.claudeConfigDirectory !== undefined && typeof parsed.claudeConfigDirectory !== "string")
    ) {
      return {
        manifest: { version: 2, components: [] },
        conflict: "Work Intelligence 安裝紀錄格式不受支援；保留且拒絕修改。",
      };
    }
    const components: ManagedEntry[] = [];
    for (const item of parsed.components) {
      if (!JSON_OBJECT(item) || typeof item.id !== "string" || typeof item.kind !== "string") {
        return {
          manifest: { version: 2, components: [] },
          conflict: "Work Intelligence 安裝紀錄有未知項目；保留且拒絕修改。",
        };
      }
      const storedId = item.id as AgentSetupComponentId;
      if (parsed.version === 1 && storedId === "codexLegacySkill") {
        return {
          manifest: { version: 2, components: [] },
          conflict: "Work Intelligence 安裝紀錄有未知項目；保留且拒絕修改。",
        };
      }
      const id = parsed.version === 1 && storedId === "codexSkill" ? "codexLegacySkill" : storedId;
      const valid =
        ((id === "codexSkill" || id === "codexLegacySkill" || id === "claudeSkill") &&
          item.kind === "file" &&
          typeof item.expected === "string") ||
        (id === "codexMcp" && item.kind === "toml-block" && typeof item.expected === "string") ||
        (id === "claudeMcp" && item.kind === "json-property" && "expected" in item) ||
        (HOOK_COMPONENT_IDS.has(id) && item.kind === "json-array-item" && "expected" in item);
      if (!valid) {
        return {
          manifest: { version: 2, components: [] },
          conflict: "Work Intelligence 安裝紀錄有未知項目；保留且拒絕修改。",
        };
      }
      components.push({ ...item, id } as ManagedEntry);
    }
    if (new Set(components.map((entry) => entry.id)).size !== components.length) {
      return {
        manifest: { version: 2, components: [] },
        conflict: "Work Intelligence 安裝紀錄有重複項目；保留且拒絕修改。",
      };
    }
    return {
      manifest: {
        version: 2,
        ...(typeof parsed.codexHomeDirectory === "string" ? { codexHomeDirectory: parsed.codexHomeDirectory } : {}),
        ...(typeof parsed.claudeConfigDirectory === "string"
          ? { claudeConfigDirectory: parsed.claudeConfigDirectory }
          : {}),
        components,
      },
    };
  } catch {
    return {
      manifest: { version: 2, components: [] },
      conflict: "Work Intelligence 安裝紀錄不是有效 JSON；保留且拒絕修改。",
    };
  }
}

export function entryIndex(entries: ManagedEntry[], id: AgentSetupComponentId): number {
  return entries.findIndex((entry) => entry.id === id);
}

export function setEntry(entries: ManagedEntry[], entry: ManagedEntry): void {
  const index = entryIndex(entries, entry.id);
  if (index < 0) entries.push(entry);
  else entries[index] = entry;
}

export function removeEntry(entries: ManagedEntry[], id: AgentSetupComponentId): void {
  const index = entryIndex(entries, id);
  if (index >= 0) entries.splice(index, 1);
}
