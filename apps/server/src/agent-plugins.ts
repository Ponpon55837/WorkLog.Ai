import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

const JSON_OBJECT_SCHEMA = z.record(z.string(), z.unknown());

function record(value: unknown): Record<string, unknown> | undefined {
  const result = JSON_OBJECT_SCHEMA.safeParse(value);
  return result.success ? result.data : undefined;
}

/**
 * Whether settings.json enables the Work Intelligence plugin (`enabledPlugins["work-intelligence@<marketplace>"]`).
 * The plugin brings its own MCP server, skill, and Stop hook, so it replaces the manual registration.
 */
export function claudePluginEnabled(settings: Record<string, unknown> | undefined): boolean {
  const enabled = record(settings?.enabledPlugins);
  return Object.entries(enabled ?? {}).some(([key, value]) => key.startsWith("work-intelligence@") && value === true);
}

/**
 * Whether config.toml enables the Work Intelligence plugin (`[plugins."work-intelligence@<marketplace>"]` with
 * `enabled = true`). It brings the MCP server and the skill; the Codex save-reminder hooks stay in hooks.json.
 */
export function codexPluginEnabled(config: Record<string, unknown> | undefined): boolean {
  return Object.entries(record(config?.plugins) ?? {}).some(
    ([key, value]) => key.startsWith("work-intelligence@") && record(value)?.enabled === true,
  );
}

/** Read-only: whether `<claudeConfigDirectory>/settings.json` enables the plugin; false when missing or unreadable. */
export function readClaudePluginEnabled(claudeConfigDirectory: string): boolean {
  try {
    return claudePluginEnabled(record(JSON.parse(readFileSync(join(claudeConfigDirectory, "settings.json"), "utf8"))));
  } catch {
    return false;
  }
}

/** Read-only: whether `<codexHomeDirectory>/config.toml` enables the plugin; false when missing or unreadable. */
export function readCodexPluginEnabled(codexHomeDirectory: string): boolean {
  try {
    const text = readFileSync(join(codexHomeDirectory, "config.toml"), "utf8");
    return codexPluginEnabled(parseToml(text, { maxDepth: 128, unsafeKeyBehaviour: "throw" }));
  } catch {
    return false;
  }
}
