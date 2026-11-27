import { resolve } from "node:path";
import { JSON_OBJECT } from "./files.js";
import {
  LAUNCHER_MCP_ARGUMENT,
  LAUNCHER_SHIM_BASENAMES,
  MCP_LAUNCHER_RELATIVE_PATH,
  MCP_SERVER_RELATIVE_PATH,
} from "./constants.js";

export function quoteShellArgument(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function commandForAgentHook(scriptPath: string, platform: NodeJS.Platform = process.platform): string {
  return `node ${quoteShellArgument(scriptPath, platform)}`;
}

export function referencesScriptPath(value: unknown, scriptPath: string): boolean {
  if (Array.isArray(value)) return value.some((item) => referencesScriptPath(item, scriptPath));
  if (!JSON_OBJECT(value)) return false;
  if (
    typeof value.command === "string" &&
    (value.command.includes(scriptPath) ||
      value.command.includes(quoteShellArgument(scriptPath, "linux")) ||
      value.command.includes(quoteShellArgument(scriptPath, "win32")))
  ) {
    return true;
  }
  if (
    Array.isArray(value.args) &&
    value.args.some(
      (argument) => typeof argument === "string" && normalizeConfigPath(argument) === normalizeConfigPath(scriptPath),
    )
  ) {
    return true;
  }
  return Object.values(value).some((item) => referencesScriptPath(item, scriptPath));
}

export function normalizeConfigPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+/g, "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isNodeExecutable(command: string): boolean {
  const executable = command.trim().replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  return executable === "node" || executable === "node.exe" || executable === "nodejs" || executable === "nodejs.exe";
}

export function isPnpmExecutable(command: string): boolean {
  const executable = command.trim().replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  return executable === "pnpm" || executable === "pnpm.cmd" || executable === "pnpm.exe";
}

/** On `win32` a backslash outside quotes is a path separator, not an escape. */
export function commandWords(command: string, platform?: NodeJS.Platform): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let wordStarted = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === undefined) continue;
    const next = command[index + 1];

    if (quote === "'") {
      if (character === "'") quote = undefined;
      else word += character;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = undefined;
      else if (character === "\\" && next === '"') {
        word += '"';
        index += 1;
      } else word += character;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      wordStarted = true;
    } else if (character === "\\" && platform !== "win32") {
      if (next === undefined) word += character;
      else {
        word += next;
        index += 1;
      }
      wordStarted = true;
    } else if (/\s/.test(character)) {
      if (wordStarted) words.push(word);
      word = "";
      wordStarted = false;
    } else {
      word += character;
      wordStarted = true;
    }
  }

  if (quote) return undefined;
  if (wordStarted) words.push(word);
  return words;
}

export function nodeCommandRunsScript(command: string, args: readonly string[], scriptPath: string): boolean {
  const parsedCommand = commandWords(command);
  if (!parsedCommand || !parsedCommand[0] || !isNodeExecutable(parsedCommand[0])) return false;
  const scriptArgument = parsedCommand[1] ?? args[0];
  return scriptArgument !== undefined && normalizeConfigPath(scriptArgument) === normalizeConfigPath(scriptPath);
}

export function invokesNodeScript(value: unknown, scriptPath: string): boolean {
  if (Array.isArray(value)) return value.some((item) => invokesNodeScript(item, scriptPath));
  if (!JSON_OBJECT(value)) return false;

  const args = Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === "string") : [];
  if (typeof value.command === "string" && nodeCommandRunsScript(value.command, args, scriptPath)) return true;
  return Object.values(value).some((item) => invokesNodeScript(item, scriptPath));
}

export function mcpRegistrationKind(value: unknown, repositoryRoot: string): "launcher" | "direct" | "other" {
  if (!JSON_OBJECT(value) || typeof value.command !== "string") return "other";
  const args = Array.isArray(value.args) ? value.args.filter((part): part is string => typeof part === "string") : [];
  if (isNodeExecutable(value.command) && args[0]) {
    const script = normalizeConfigPath(args[0]);
    if (script === normalizeConfigPath(resolve(repositoryRoot, MCP_LAUNCHER_RELATIVE_PATH))) return "launcher";
    if (script === normalizeConfigPath(resolve(repositoryRoot, MCP_SERVER_RELATIVE_PATH))) return "direct";
    return "other";
  }
  if (!isPnpmExecutable(value.command) || !args.includes("start:mcp")) return "other";

  const dirFlag = args.findIndex((part) => part === "--dir" || part === "-C");
  const directory = dirFlag >= 0 ? args[dirFlag + 1] : typeof value.cwd === "string" ? value.cwd : undefined;
  return directory !== undefined && normalizeConfigPath(directory) === normalizeConfigPath(resolve(repositoryRoot))
    ? "launcher"
    : "other";
}

export function upgradeDirectMcpRegistration(value: unknown, repositoryRoot: string): unknown {
  if (mcpRegistrationKind(value, repositoryRoot) !== "direct" || !JSON_OBJECT(value) || !Array.isArray(value.args)) {
    return undefined;
  }
  return { ...value, args: [resolve(repositoryRoot, MCP_LAUNCHER_RELATIVE_PATH), ...value.args.slice(1)] };
}

export function commandForLauncherHook(
  shimPath: string,
  action: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return `${quoteShellArgument(shimPath, platform)} ${action}`;
}

export function isLauncherShimCommand(command: string, shimPath?: string): boolean {
  if (shimPath !== undefined) return normalizeConfigPath(command) === normalizeConfigPath(shimPath);
  return LAUNCHER_SHIM_BASENAMES.has(command.trim().replaceAll("\\", "/").split("/").at(-1) ?? "");
}

export function isLauncherMcpRegistration(value: unknown, shimPath?: string): boolean {
  if (!JSON_OBJECT(value) || typeof value.command !== "string" || !isLauncherShimCommand(value.command, shimPath)) {
    return false;
  }
  return Array.isArray(value.args) && value.args.length === 1 && value.args[0] === LAUNCHER_MCP_ARGUMENT;
}

export function invokesLauncherAction(value: unknown, action: string, shimPath?: string): boolean {
  if (Array.isArray(value)) return value.some((item) => invokesLauncherAction(item, action, shimPath));
  if (!JSON_OBJECT(value)) return false;
  if (typeof value.command === "string") {
    const words = commandWords(value.command);
    if (words?.[0] && isLauncherShimCommand(words[0], shimPath) && words[1] === action && words.length === 2) {
      return true;
    }
  }
  return Object.values(value).some((item) => invokesLauncherAction(item, action, shimPath));
}

export function unwrapCmd(command: string, args: readonly string[]): { command: string; args: string[] } {
  const executable = command.trim().replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  if (executable !== "cmd" && executable !== "cmd.exe") return { command, args: [...args] };
  const switchIndex = args.findIndex((argument) => argument.toLowerCase() === "/c");
  const wrapped = switchIndex >= 0 && args.slice(0, switchIndex).every((argument) => /^\/[a-z]$/i.test(argument));
  const [inner, ...rest] = wrapped ? args.slice(switchIndex + 1) : [];
  return inner === undefined ? { command, args: [...args] } : { command: inner, args: rest };
}
