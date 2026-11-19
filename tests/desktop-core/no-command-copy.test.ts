import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as desktopCore from "../../packages/desktop-core/src/index.js";
import {
  describeLegacyDisableSteps,
  planLegacyDisable,
  setupMessages,
  type ShellLocale,
} from "../../packages/desktop-core/src/index.js";

/**
 * The desktop App never asks the user to type a command (M-15). Every user-visible string of the App is scanned: the
 * i18n dictionaries (both languages) and every string or template literal in the renderer sources.
 */

const WEB_LOCALES = ["zh-TW", "en-US"] as const;
const WEB_LOCALE_ROOT = fileURLToPath(new URL("../../apps/web/src/i18n/locales", import.meta.url));
const RENDERER_ROOT = fileURLToPath(new URL("../../apps/desktop/src/renderer", import.meta.url));
const LOCALES: readonly ShellLocale[] = ["zh-TW", "en"];

/** Package runners the user would have to type. */
const PACKAGE_RUNNER = /\b(?:pnpm|npm|npx|yarn)\b/i;
/** A place the user would have to type into. A bare "PowerShell" is fine: it is only matched next to an instruction. */
const TYPING_PLACE =
  /終端機|終端|命令列|命令提示|指令提示|\bterminal\b|command[ -]line|command prompt|cmd\.exe|(?:open|run|launch|in|execute|開啟|執行|在)\s*(?:a\s+|the\s+)?(?:Windows\s+)?PowerShell/i;
/** "Run / type / paste this command". */
const TYPE_A_COMMAND =
  /(?:執行|輸入|貼上|複製)[^。]{0,8}(?:指令|命令)|(?:run|type|paste|copy)\s+(?:this|the following|the)\s+command/i;
/** A line that is a shell command: a leading prompt, a known command word with an argument, or a ` --flag`. */
const SHELL_SHAPE = /^\s*\$\s|^\s*(?:sudo|cd|launchctl|systemctl|schtasks(?:\.exe)?|rm|brew|node)\s+\S|\s--[a-z][\w-]*/;

const FORBIDDEN: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "package runner", pattern: PACKAGE_RUNNER },
  { name: "terminal / command line / prompt", pattern: TYPING_PLACE },
  { name: "run-a-command instruction", pattern: TYPE_A_COMMAND },
  { name: "shell command shape", pattern: SHELL_SHAPE },
];

/**
 * Strings that may match and why. Keep it minimal; each entry is an exact string with the reason it is not an
 * instruction to the user. Empty on purpose: nothing needs it today.
 */
const ALLOWED: ReadonlyMap<string, string> = new Map();

interface Found {
  readonly where: string;
  readonly text: string;
}

function collectDictionary(value: unknown, where: string, out: Found[]): void {
  if (typeof value === "string") out.push({ where, text: value });
  else if (Array.isArray(value)) value.forEach((item, index) => collectDictionary(item, `${where}[${index}]`, out));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) collectDictionary(child, `${where}.${key}`, out);
  }
}

/**
 * Every dictionary the shell module exports, found by name (`...Messages(locale)`) so a new one is scanned without anyone
 * remembering to add it here; a list kept by hand is how restoreMessages and agentRemoveMessages were once missed.
 */
function dictionaryFunctions(): readonly [string, (locale: ShellLocale) => unknown][] {
  return Object.entries(desktopCore)
    .filter(([name, value]) => /Messages$/.test(name) && typeof value === "function" && value.length === 1)
    .map(([name, value]) => [name, value as (locale: ShellLocale) => unknown]);
}

function dictionaryStrings(): Found[] {
  const out: Found[] = [];
  for (const locale of LOCALES) {
    for (const [name, messages] of dictionaryFunctions())
      collectDictionary(messages(locale), `${name}[${locale}]`, out);
  }
  return out;
}

/**
 * The web page strings a desktop-managed window shows: the Agent connections and legacy-service parts of the status page
 * and the first-run checklist's Agent step. The web's CLI help pages (and the command shown to a user of the plain web
 * server) are for people who run the server themselves and stay outside this guard on purpose.
 */
const DESKTOP_WEB_KEYS: readonly string[] = [
  "systemStatus.agentsInOtherProjectsNeedDesktop",
  "systemStatus.openAgentSetupInDesktopApp",
  "systemStatus.legacyServiceWarning",
  "systemStatus.legacyServiceStartsAtLogin",
  "systemStatus.legacyServiceTurnOffInApp",
  "systemStatus.localServiceStatusDesktop",
  "systemStatus.recentResultsAppearAfterMaintenance",
  "projects.restoreInDesktopApp",
];

/**
 * Every other string of the web locale that matches a pattern above, by key. Each is shown only outside the
 * desktop-managed window (the web server's own wording, with the desktop sentence above taking its place there) or is a
 * prompt pasted into an Agent conversation rather than a shell command. A new match fails the test until it is
 * either reworded or listed here with its reason.
 */
const WEB_OUTSIDE_DESKTOP: ReadonlyMap<string, string> = new Map([
  [
    "systemStatus.localServiceDatabaseBackupMaintenance",
    "page subtitle; the desktop window shows localServiceStatusDesktop",
  ],
  [
    "systemStatus.recentResultsAppearAfterRunning",
    "maintenance hint; the desktop window shows recentResultsAppearAfterMaintenance",
  ],
  [
    "systemStatus.agentsInOtherProjectsNeed",
    "Agent hint with the setup command; the desktop window shows agentsInOtherProjectsNeedDesktop",
  ],
  ["systemStatus.copyCommand", "button of the command above, not shown in the desktop window"],
  ["projects.pnpmDbRestoreExportFile", "restore command, replaced by restoreInDesktopApp in the desktop window"],
  ["projects.runTheCommandBelowFrom", "step of the restore command, replaced by restoreInDesktopApp"],
  ["projects.copyRestoreCommand", "button of the restore command, not shown in the desktop window"],
  ["projects.restoreCommandCopied", "toast of the restore command, not shown in the desktop window"],
  ["dashboard.copyInstallCommand", "checklist button, hidden when desktop-managed"],
  ["common.copyAgentInstruction", "copies a prompt for the Agent conversation, not a shell command"],
  ["dashboard.workRecordInstructionCopied", "toast of a prompt for the Agent conversation"],
  ["projects.pasteTheInstructionBelowInto", "prompt for the Agent conversation"],
  ["reports.pasteTheInstructionBelowInto", "prompt for the Agent conversation"],
  ["reports.naturalLanguageSynthesisInstructionCopied", "toast of a prompt for the Agent conversation"],
]);

function webLocaleStrings(): Found[] {
  const out: Found[] = [];
  for (const locale of WEB_LOCALES) {
    const messages = JSON.parse(readFileSync(path.join(WEB_LOCALE_ROOT, `${locale}.json`), "utf8")) as unknown;
    collectDictionary(messages, `web[${locale}]`, out);
  }
  return out;
}

function webDesktopStrings(): Found[] {
  const out: Found[] = [];
  for (const locale of WEB_LOCALES) {
    const messages = JSON.parse(readFileSync(path.join(WEB_LOCALE_ROOT, `${locale}.json`), "utf8")) as Record<
      string,
      unknown
    >;
    for (const key of DESKTOP_WEB_KEYS) {
      const value = key
        .split(".")
        .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages);
      if (typeof value === "string") out.push({ where: `web[${locale}].${key}`, text: value });
    }
  }
  return out;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : [full];
  });
}

/** A token with no space and no CJK (`div`, `card--attention`, `data-testid`, a path) is an identifier, not copy. */
function isIdentifierLike(text: string): boolean {
  return !/\s/.test(text) && [...text].every((character) => character.charCodeAt(0) <= 0x24f);
}

/** Positions where a string literal is not user-visible: import/export specifiers, type literals, property names. */
function isNotCopy(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  if (ts.isLiteralTypeNode(parent) || ts.isImportTypeNode(parent) || ts.isExternalModuleReference(parent)) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;
  if (ts.isCallExpression(parent) && parent.expression.getText() === "import") return true;
  // A class or data-* attribute name, a selector or an event name handed to the DOM.
  if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)) {
    const method = parent.expression.name.text;
    if (
      [
        "setAttribute",
        "getAttribute",
        "removeAttribute",
        "querySelector",
        "querySelectorAll",
        "addEventListener",
      ].includes(method) &&
      parent.arguments[0] === node
    ) {
      return true;
    }
  }
  return false;
}

function rendererStrings(): { found: Found[]; files: number } {
  const found: Found[] = [];
  const files = sourceFiles(RENDERER_ROOT);
  for (const file of files) {
    const relative = path.relative(RENDERER_ROOT, file);
    const content = readFileSync(file, "utf8");
    if (file.endsWith(".html")) {
      // Visible text of static markup: what is outside the tags and the attribute values `title`, `aria-label`, `alt`.
      const text = content.replace(/<!--[\s\S]*?-->|<(?:script|style)[\s\S]*?<\/(?:script|style)>/g, "");
      for (const match of text.matchAll(/>([^<]+)</g)) found.push({ where: relative, text: match[1]!.trim() });
      for (const match of text.matchAll(/\b(?:title|aria-label|alt|placeholder)="([^"]*)"/g)) {
        found.push({ where: relative, text: match[1]! });
      }
      continue;
    }
    if (!file.endsWith(".ts")) continue;
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (!isNotCopy(node) && !isIdentifierLike(node.text)) found.push({ where: relative, text: node.text });
      } else if (ts.isTemplateExpression(node)) {
        // Each fixed part is checked on its own; the `${}` holes are values, never copy.
        const parts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
        for (const text of parts) if (!isIdentifierLike(text)) found.push({ where: relative, text });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { found, files: files.length };
}

function violations(strings: readonly Found[]): string[] {
  const hits: string[] = [];
  for (const { where, text } of strings) {
    if (ALLOWED.has(text)) continue;
    for (const { name, pattern } of FORBIDDEN) {
      if (pattern.test(text)) hits.push(`${where} [${name}]: ${text}`);
    }
  }
  return hits;
}

describe("no command copy in the desktop App (M-15)", () => {
  it("scans a believable amount of dictionary and renderer text", () => {
    const dictionary = dictionaryStrings();
    const renderer = rendererStrings();
    expect(dictionary.length).toBeGreaterThan(500);
    expect(dictionary.filter((entry) => entry.where.startsWith("shellMessages[zh-TW]")).length).toBeGreaterThan(50);
    expect(dictionary.filter((entry) => entry.where.startsWith("setupMessages[en]")).length).toBeGreaterThan(100);
    // The dictionaries found by name include the ones that were once left off a hand-written list.
    const names = new Set(dictionaryFunctions().map(([name]) => name));
    for (const name of ["shellMessages", "setupMessages", "restoreMessages", "agentRemoveMessages"]) {
      expect(names.has(name), name).toBe(true);
      expect(dictionary.filter((entry) => entry.where.startsWith(`${name}[`)).length, name).toBeGreaterThan(10);
    }
    // Every desktop-facing web key exists in both languages (a renamed key must not silently leave the guard).
    expect(webDesktopStrings()).toHaveLength(DESKTOP_WEB_KEYS.length * WEB_LOCALES.length);
    expect(renderer.files).toBeGreaterThan(15);
    expect(renderer.found.length).toBeGreaterThan(30);
  });

  it("no dictionary string (zh-TW or en) asks the user to run a command", () => {
    expect(violations(dictionaryStrings())).toEqual([]);
  });

  it("no web string shown in the desktop-managed window asks the user to run a command", () => {
    expect(violations(webDesktopStrings())).toEqual([]);
  });

  it("every web locale string that reads like a command is either reworded or listed as shown outside the desktop window", () => {
    const strings = webLocaleStrings();
    expect(strings.length).toBeGreaterThan(2000);
    const matching = new Set(
      strings
        .filter((entry) => violations([entry]).length > 0)
        .map((entry) => entry.where.slice(entry.where.indexOf("]") + 2)),
    );
    expect([...matching].filter((key) => !WEB_OUTSIDE_DESKTOP.has(key))).toEqual([]);
    // A listed key that no longer matches (or no longer exists) is stale and must leave the list.
    expect([...WEB_OUTSIDE_DESKTOP.keys()].filter((key) => !matching.has(key))).toEqual([]);
  });

  it("no renderer string asks the user to run a command", () => {
    expect(violations(rendererStrings().found)).toEqual([]);
  });

  it("the 「詳細步驟」 lines of a legacy-disable preview are plain sentences, not shell commands", () => {
    const lines: Found[] = [];
    const root = {
      win32: "C:\\Users\\synthetic\\work-log",
      darwin: "/Users/synthetic/work-log",
      linux: "/home/synthetic/work-log",
    };
    for (const platform of ["win32", "darwin", "linux"] as const) {
      const plan = planLegacyDisable(
        {
          kind: "found" as const,
          platform,
          recognised: true,
          running: "running" as const,
          definitionSource: "file",
          definitionPath: platform === "win32" ? "C:\\data\\task.xml" : "/home/synthetic/definition.plist",
          definitionDigest: "a".repeat(64),
          repositoryRoot: root[platform],
          port: 3000,
        },
        { uid: 501, environment: { SystemRoot: "C:\\Windows" } },
      );
      expect(plan, platform).not.toBeNull();
      for (const locale of LOCALES) {
        const steps = describeLegacyDisableSteps(plan!, setupMessages(locale).legacyDisableStepText);
        expect(steps.length, `${platform} ${locale}`).toBe(plan!.steps.length);
        steps.forEach((text, index) => lines.push({ where: `legacy-steps[${platform}][${locale}][${index}]`, text }));
      }
    }
    expect(violations(lines)).toEqual([]);
    // A command line would show its tool name; none of the generated lines may.
    for (const { where, text } of lines) {
      expect(text, where).not.toMatch(/schtasks|launchctl|systemctl|taskkill|Remove-Item|\/(?:TN|PID|F)\b/i);
    }
  });

  it("the patterns do recognise the copy this guard exists for", () => {
    const bad = [
      "在終端機執行這個指令移除它：",
      "Remove it by running this command in a terminal:",
      "請先移除舊的登入服務（pnpm service:uninstall）",
      "cd '/srv/repo' && pnpm service:uninstall",
      "$ launchctl bootout gui/501/x",
      "node runner.js --legacy",
      "Open PowerShell and paste it",
    ];
    for (const text of bad) expect(violations([{ where: "probe", text }]).length, text).toBeGreaterThan(0);
    const good = ["打開「工作排程器」並找到 Work Intelligence", "Open Task Scheduler, then press “Check again”."];
    for (const text of good) expect(violations([{ where: "probe", text }]), text).toEqual([]);
  });
});
