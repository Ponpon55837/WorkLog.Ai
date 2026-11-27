import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");

const USER_DOCUMENTS = [
  "README.md",
  "README.zh-TW.md",
  "docs/user-guide.md",
  "docs/troubleshooting.md",
  "docs/agent-setup.md",
  "docs/service.md",
  "docs/standalone.md",
  "docs/release.md",
] as const;

const SUPERSEDED: ReadonlyArray<{ readonly phrase: RegExp; readonly now: string }> = [
  { phrase: /目前沒有還原流程|沒有還原流程/, now: "the App restores backups from the Data tab (1.6.56+)" },
  {
    phrase: /修復視窗/,
    now: "the one App window with its Status, Data and Settings tabs: say 「App 視窗」 or name the tab",
  },
  { phrase: /repair window/i, now: "the App window and its tabs" },
  { phrase: /桌面 App[^。\n]*(?:不能|無法|不支援)[^。\n]*還原/, now: "the App restores backups from the Data tab" },
  {
    phrase: /(?:手動執行|用) pnpm (?:--dir \S+ )?start:mcp[^\n]*(?:註冊|mcp add)/,
    now: "set up Agents in the App's Agent tab (1.6.49+); the launcher is registered for you",
  },
  {
    phrase: /手寫 (?:node|hook)|手寫的 hook/,
    now: "the App previews and applies the Agent setup; undo returns the files",
  },
];

describe("user documents do not repeat superseded claims", () => {
  for (const file of USER_DOCUMENTS) {
    const text = readFileSync(path.join(ROOT, file), "utf8");
    for (const { phrase, now } of SUPERSEDED) {
      it(`${file} has no ${phrase}`, () => {
        const hit = text.split("\n").findIndex((line) => phrase.test(line));
        expect(hit === -1 ? null : `line ${hit + 1}: now ${now}`).toBeNull();
      });
    }
  }

  it("the user guide documents the in-App restore, maintenance, backup location and port fallback", () => {
    const guide = readFileSync(path.join(ROOT, "docs/user-guide.md"), "utf8");
    for (const heading of ["從備份還原", "整理資料庫", "備份位置", "上次正常運作的連接埠"])
      expect(guide).toContain(heading);
  });

  it("the release checklist asks for the user guide to change with a user-visible feature", () => {
    const checklist = readFileSync(path.join(ROOT, "docs/release-checklist.md"), "utf8");
    expect(checklist).toContain("docs/user-guide.md");
  });
});
