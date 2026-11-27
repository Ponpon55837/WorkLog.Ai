import { posix, win32 } from "node:path";
import { databasePathFor } from "@work-intelligence/shared/database-location";
import {
  LEGACY_LAUNCHD_LABEL,
  LEGACY_RUNNER_RELATIVE_PATH,
  LEGACY_SYSTEMD_DESCRIPTION,
  legacyWindowsTaskTarget,
} from "./constants.js";
import type { LegacyServicePlatform } from "./types.js";

export interface InterpretedDefinition {
  recognised: boolean;
  repositoryRoot?: string;
  databasePath?: string;
  backupDirectory?: string;
  port?: number;
}

const RUNNER_ARGUMENT_COUNT = 7;
const UNRECOGNISED: InterpretedDefinition = { recognised: false };

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

function pathApi(platform: LegacyServicePlatform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function xmlStrings(fragment: string): string[] {
  return [...fragment.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => unescapeXml(match[1] ?? ""));
}

function xmlElement(text: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return match ? unescapeXml(match[1] ?? "") : undefined;
}

function parsePort(value: string | undefined): number | undefined {
  const port = Number(value);
  return value !== undefined && Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

function splitSystemdWords(line: string): string[] | undefined {
  const words: string[] = [];
  let index = 0;
  while (index < line.length) {
    if (line[index] === " ") {
      index += 1;
      continue;
    }
    if (line[index] !== '"') return undefined;
    index += 1;
    let word = "";
    for (;;) {
      const character = line[index];
      if (character === undefined) return undefined;
      if (character === '"') break;
      const next = line[index + 1];
      if (character === "\\" && (next === "\\" || next === '"')) {
        word += next;
        index += 2;
      } else if ((character === "$" || character === "%") && next === character) {
        word += character;
        index += 2;
      } else {
        word += character;
        index += 1;
      }
    }
    index += 1;
    words.push(word);
  }
  return words;
}

function splitWindowsWords(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quoted = false;
  let index = 0;
  while (index < line.length) {
    const character = line[index];
    if (character === "\\") {
      let count = 0;
      while (line[index] === "\\") {
        count += 1;
        index += 1;
      }
      started = true;
      if (line[index] === '"') {
        word += "\\".repeat(Math.floor(count / 2));
        if (count % 2 === 1) {
          word += '"';
          index += 1;
        }
      } else {
        word += "\\".repeat(count);
      }
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && (character === " " || character === "\t")) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += character;
      started = true;
    }
    index += 1;
  }
  if (started) words.push(word);
  return words;
}

function interpretRunnerArguments(
  platform: LegacyServicePlatform,
  args: string[],
  workingDirectory: string | undefined,
): InterpretedDefinition {
  const path = pathApi(platform);
  if (args.length !== RUNNER_ARGUMENT_COUNT) return UNRECOGNISED;
  const [nodeExecutable, runner, repositoryRoot, rawDatabase, backup, packageManager, log] = args as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const absolute = [nodeExecutable, repositoryRoot, packageManager].every((value) => path.isAbsolute(value));
  const wellFormed = [repositoryRoot, rawDatabase, backup, log].every(
    (value) => value.length > 0 && !hasControlCharacter(value),
  );
  if (!absolute || !wellFormed) return UNRECOGNISED;
  if (runner !== path.join(repositoryRoot, LEGACY_RUNNER_RELATIVE_PATH)) return UNRECOGNISED;
  if (workingDirectory !== repositoryRoot) return UNRECOGNISED;
  let databasePath: string | undefined;
  try {
    databasePath = databasePathFor(repositoryRoot, {
      standalone: false,
      environment: { WORK_INTELLIGENCE_DB: rawDatabase },
      platform,
    });
  } catch {
    databasePath = undefined;
  }
  return {
    recognised: true,
    repositoryRoot,
    ...(databasePath && databasePath !== ":memory:" ? { databasePath } : {}),
    ...(path.isAbsolute(backup) ? { backupDirectory: backup } : {}),
  };
}

function interpretLaunchAgent(text: string): InterpretedDefinition {
  const label = /<key>Label<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(text);
  const argumentsBlock = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
  const workingDirectory = /<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(text);
  if (!label || unescapeXml(label[1] ?? "") !== LEGACY_LAUNCHD_LABEL || !argumentsBlock) return UNRECOGNISED;
  const port = /<key>WORK_INTELLIGENCE_PORT<\/key>\s*<string>(\d+)<\/string>/.exec(text)?.[1];
  const interpreted = interpretRunnerArguments(
    "darwin",
    xmlStrings(argumentsBlock[1] ?? ""),
    workingDirectory ? unescapeXml(workingDirectory[1] ?? "") : undefined,
  );
  return { ...interpreted, ...(parsePort(port) ? { port: parsePort(port) } : {}) };
}

function interpretSystemdUnit(text: string): InterpretedDefinition {
  const lines = text.split(/\r?\n/);
  const valuesOf = (key: string): string[] =>
    lines.filter((line) => line.startsWith(`${key}=`)).map((line) => line.slice(key.length + 1));
  const execStart = valuesOf("ExecStart");
  const workingDirectory = valuesOf("WorkingDirectory");
  if (valuesOf("Description")[0] !== LEGACY_SYSTEMD_DESCRIPTION) return UNRECOGNISED;
  if (execStart.length !== 1 || workingDirectory.length !== 1) return UNRECOGNISED;
  const args = splitSystemdWords(execStart[0] ?? "");
  const directory = splitSystemdWords(workingDirectory[0] ?? "");
  if (!args || directory?.length !== 1) return UNRECOGNISED;
  const port = /WORK_INTELLIGENCE_PORT=(\d+)/.exec(valuesOf("Environment").join("\n"))?.[1];
  const interpreted = interpretRunnerArguments("linux", args, directory[0]);
  return { ...interpreted, ...(parsePort(port) ? { port: parsePort(port) } : {}) };
}

function interpretWindowsTask(text: string): InterpretedDefinition {
  const uri = xmlElement(text, "URI");
  const command = xmlElement(text, "Command");
  const rawArguments = xmlElement(text, "Arguments");
  const workingDirectory = xmlElement(text, "WorkingDirectory");
  if (uri !== legacyWindowsTaskTarget() || rawArguments === undefined) return UNRECOGNISED;
  if (!/(^|[\\/])conhost\.exe$/i.test(command ?? "")) return UNRECOGNISED;
  const words = splitWindowsWords(rawArguments);
  if (words[0] !== "--headless") return UNRECOGNISED;
  return interpretRunnerArguments("win32", words.slice(1), workingDirectory);
}

export function interpretLegacyDefinition(platform: LegacyServicePlatform, text: string): InterpretedDefinition {
  if (platform === "darwin") return interpretLaunchAgent(text);
  if (platform === "linux") return interpretSystemdUnit(text);
  return interpretWindowsTask(text);
}

export function decodeLegacyDefinition(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  return buffer.toString("utf8");
}
