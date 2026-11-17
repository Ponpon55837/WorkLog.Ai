import { resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { JSON_OBJECT } from "./files.js";
import { mcpRegistrationKind } from "./commands.js";
import {
  LAUNCHER_MCP_ARGUMENT,
  MCP_LAUNCHER_RELATIVE_PATH,
  MCP_SERVER_RELATIVE_PATH,
  TOML_BLOCK_END,
  TOML_BLOCK_START,
} from "./constants.js";
import type { AgentSetupPlanOptions, CodexHooksFeature } from "./types.js";

/** Reads `[mcp_servers.work-intelligence]` from config.toml when it parses; undefined otherwise. */
export function codexWorkIntelligenceServer(tomlText: string): unknown {
  try {
    const config = parseToml(tomlText, { maxDepth: 128, unsafeKeyBehaviour: "throw" }) as Record<string, unknown>;
    const servers = config.mcp_servers;
    return JSON_OBJECT(servers) ? servers["work-intelligence"] : undefined;
  } catch {
    return undefined;
  }
}

/** A real TOML parse; Codex writes array tables and quoted headers (`hooks[0]`) a line scanner misreads. */
export function codexHooksFeatureFromToml(text: string | undefined): CodexHooksFeature {
  if (text === undefined) return "enabled";
  let config: Record<string, unknown>;
  try {
    config = parseToml(text, { maxDepth: 128, unsafeKeyBehaviour: "throw" }) as Record<string, unknown>;
  } catch {
    return "unknown";
  }
  const features = config.features;
  if (features === undefined) return "enabled";
  if (!JSON_OBJECT(features)) return "unknown";
  const values = [features.hooks, features.codex_hooks].filter((value) => value !== undefined);
  if (values.some((value) => typeof value !== "boolean")) return "unknown";
  return values.includes(false) ? "disabled" : "enabled";
}

export function codexTomlBlock(options: AgentSetupPlanOptions, newline: string): string {
  const [command, args] =
    options.target?.kind === "launcher"
      ? [options.target.shimPath, LAUNCHER_MCP_ARGUMENT]
      : ["node", resolve(options.repositoryRoot, MCP_LAUNCHER_RELATIVE_PATH)];
  return [
    TOML_BLOCK_START,
    "[mcp_servers.work-intelligence]",
    `command = ${JSON.stringify(command)}`,
    `args = [${JSON.stringify(args)}]`,
    TOML_BLOCK_END,
    "",
  ].join(newline);
}

/**
 * Rewrites the one quoted server path in a hand-written `node <repo>/apps/mcp/dist/index.js` Codex registration to the
 * launcher, in the same TOML string style. Undefined when the path is not found exactly once.
 */
export function upgradeDirectCodexRegistration(text: string, repositoryRoot: string): string | undefined {
  const serverPath = resolve(repositoryRoot, MCP_SERVER_RELATIVE_PATH);
  const launcherPath = resolve(repositoryRoot, MCP_LAUNCHER_RELATIVE_PATH);
  const forms = [
    [JSON.stringify(serverPath), JSON.stringify(launcherPath)],
    [`'${serverPath}'`, `'${launcherPath}'`],
  ] as const;
  const matches = forms.filter(([quoted]) => text.includes(quoted));
  const match = matches[0];
  if (matches.length !== 1 || !match || text.split(match[0]).length !== 2) return undefined;
  const upgraded = text.replace(match[0], match[1]);
  return mcpRegistrationKind(codexWorkIntelligenceServer(upgraded), repositoryRoot) === "launcher"
    ? upgraded
    : undefined;
}

/**
 * Codex appends per-tool approvals (`[mcp_servers.work-intelligence.tools.<tool>]`) after the last table,
 * which lands inside our block when it ends the file. Returns the text with the block rewritten to
 * `desiredBlock` and those tables moved after it, or undefined when anything else differs from `ownedBlock`.
 */
export function moveCodexToolTablesOutOfBlock(
  text: string,
  ownedBlock: string,
  desiredBlock: string,
  newline: string,
): string | undefined {
  const start = text.indexOf(TOML_BLOCK_START);
  const endMarker = start < 0 ? -1 : text.indexOf(TOML_BLOCK_END, start);
  if (endMarker < 0) return undefined;
  let end = endMarker + TOML_BLOCK_END.length;
  if (text.startsWith(newline, end)) end += newline.length;
  const blockLines: string[] = [];
  const toolLines: string[] = [];
  let inToolTable = false;
  for (const line of text.slice(start, end).split(newline)) {
    const header = /^\[([^[].*)\]\s*(?:#.*)?$/.exec(line.trim());
    if (header) {
      const path = parseTomlKeyPath(header[1] ?? "");
      inToolTable = path?.[0] === "mcp_servers" && path[1] === "work-intelligence" && path[2] === "tools";
    } else if (line.trim() === TOML_BLOCK_END) {
      inToolTable = false;
    }
    (inToolTable ? toolLines : blockLines).push(line);
  }
  const meaningful = (lines: string[]) => lines.filter((line) => line.trim() !== "").join("\n");
  if (!toolLines.length || meaningful(blockLines) !== meaningful(ownedBlock.split(newline))) return undefined;
  return text.slice(0, start) + desiredBlock + toolLines.join(newline) + newline + text.slice(end);
}

export function parseTomlKeyPath(source: string): string[] | undefined {
  const keys: string[] = [];
  let index = 0;
  while (index < source.length) {
    while (/\s/.test(source[index] ?? "")) index += 1;
    const quote = source[index];
    if (quote === '"' || quote === "'") {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < source.length) {
        const char = source[index];
        if (quote === '"' && !escaped && char === "\\") {
          escaped = true;
          index += 1;
          continue;
        }
        if (!escaped && char === quote) break;
        escaped = false;
        index += 1;
      }
      if (index >= source.length) return undefined;
      const token = source.slice(start, index + 1);
      let value: string;
      if (quote === '"') {
        try {
          value = JSON.parse(token) as string;
        } catch {
          return undefined;
        }
      } else {
        value = token.slice(1, -1);
      }
      keys.push(value);
      index += 1;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(source.slice(index));
      if (!match) return undefined;
      keys.push(match[0]);
      index += match[0].length;
    }
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (index === source.length) break;
    if (source[index] !== ".") return undefined;
    index += 1;
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (index === source.length) return undefined;
  }
  return keys.length ? keys : undefined;
}

export function tomlHasUnsupportedMcpEntry(text: string): boolean {
  let section: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const header = /^\[\[?(.+?)\]\]?\s*(?:#.*)?$/.exec(trimmed);
    if (header) {
      const headerText = header[1] ?? "";
      const parsed = parseTomlKeyPath(headerText);
      if (!parsed) return true;
      section = parsed;
      if (section[0] === "mcp_servers" && section[1] === "work-intelligence") return true;
      continue;
    }
    const equalIndex = trimmed.indexOf("=");
    if (equalIndex < 0) {
      if (section[0] === "mcp_servers" || /mcp_servers/.test(trimmed)) return true;
      continue;
    }
    const keyText = trimmed.slice(0, equalIndex).trim();
    const parsed = parseTomlKeyPath(keyText);
    if (!parsed) {
      if (section[0] === "mcp_servers" || /mcp_servers/.test(keyText)) return true;
      continue;
    }
    const fullPath = section.length ? [...section, ...parsed] : parsed;
    if (fullPath[0] === "mcp_servers" && fullPath[1] === "work-intelligence") return true;
    if (fullPath.length === 1 && fullPath[0] === "mcp_servers") return true;
    if (section.length === 1 && section[0] === "mcp_servers" && parsed[0] === "work-intelligence") return true;
  }
  return false;
}
