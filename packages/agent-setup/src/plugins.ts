import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

const JSON_OBJECT_SCHEMA = z.record(z.string(), z.unknown());

function record(value: unknown): Record<string, unknown> | undefined {
  const result = JSON_OBJECT_SCHEMA.safeParse(value);
  return result.success ? result.data : undefined;
}

export function claudePluginEnabled(settings: Record<string, unknown> | undefined): boolean {
  const enabled = record(settings?.enabledPlugins);
  return Object.entries(enabled ?? {}).some(([key, value]) => key.startsWith("work-intelligence@") && value === true);
}

export function codexPluginEnabled(config: Record<string, unknown> | undefined): boolean {
  return Object.entries(record(config?.plugins) ?? {}).some(
    ([key, value]) => key.startsWith("work-intelligence@") && record(value)?.enabled === true,
  );
}

// The plugin is enabled or Codex keeps trust state for one of its hooks: either way its reminder fires next to the App's.
export function codexPluginHooksPresent(config: Record<string, unknown> | undefined): boolean {
  if (codexPluginEnabled(config)) return true;
  const state = record(record(config?.hooks)?.state);
  return Object.keys(state ?? {}).some((key) => key.startsWith("work-intelligence@"));
}

export function readClaudePluginEnabled(claudeConfigDirectory: string): boolean {
  try {
    return claudePluginEnabled(record(JSON.parse(readFileSync(join(claudeConfigDirectory, "settings.json"), "utf8"))));
  } catch {
    return false;
  }
}

export function readCodexPluginEnabled(codexHomeDirectory: string): boolean {
  try {
    const text = readFileSync(join(codexHomeDirectory, "config.toml"), "utf8");
    return codexPluginEnabled(parseToml(text, { maxDepth: 128, unsafeKeyBehaviour: "throw" }));
  } catch {
    return false;
  }
}

export function readCodexPluginHooksPresent(codexHomeDirectory: string): boolean {
  try {
    const text = readFileSync(join(codexHomeDirectory, "config.toml"), "utf8");
    return codexPluginHooksPresent(parseToml(text, { maxDepth: 128, unsafeKeyBehaviour: "throw" }));
  } catch {
    return false;
  }
}
