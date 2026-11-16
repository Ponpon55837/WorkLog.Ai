import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isMachOHeader,
  listAppEntries,
  planSigningOrder,
  type AppEntry,
} from "../../apps/desktop/scripts/mac-ad-hoc-sign.mjs";

const FRAMEWORK = "Contents/Frameworks/Electron Framework.framework";
const HELPER = "Contents/Frameworks/Work Intelligence Helper (GPU).app";

function header(...bytes: number[]): Uint8Array {
  return Uint8Array.from([...bytes, 0, 0, 0, 0, 0, 0, 0, 0].slice(0, 8));
}

const temporaryDirectories: string[] = [];

function file(path: string, machO = true): AppEntry {
  return { path, type: "file", machO };
}

function directory(path: string): AppEntry {
  return { path, type: "directory" };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Mach-O header detection", () => {
  it("accepts thin headers in both byte orders and both widths", () => {
    expect(isMachOHeader(header(0xfe, 0xed, 0xfa, 0xce))).toBe(true);
    expect(isMachOHeader(header(0xfe, 0xed, 0xfa, 0xcf))).toBe(true);
    expect(isMachOHeader(header(0xce, 0xfa, 0xed, 0xfe))).toBe(true);
    expect(isMachOHeader(header(0xcf, 0xfa, 0xed, 0xfe))).toBe(true);
  });

  it("accepts a fat header with a small architecture count, in both byte orders", () => {
    expect(isMachOHeader(header(0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2))).toBe(true);
    expect(isMachOHeader(header(0xbe, 0xba, 0xfe, 0xca, 2, 0, 0, 0))).toBe(true);
  });

  it("rejects a Java class file, which shares the fat magic", () => {
    expect(isMachOHeader(header(0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0x34))).toBe(false);
  });

  it("rejects text, empty and short files", () => {
    expect(isMachOHeader(new TextEncoder().encode("#!/bin/sh\n"))).toBe(false);
    expect(isMachOHeader(new Uint8Array())).toBe(false);
    expect(isMachOHeader(header(0xfe, 0xed))).toBe(false);
  });
});

describe("signing order", () => {
  const entries: AppEntry[] = [
    directory("Contents"),
    file("Contents/MacOS/Work Intelligence"),
    file("Contents/Resources/app.asar", false),
    file("Contents/Resources/runtime-bundle/runtimes/node/bin/node"),
    file("Contents/Resources/runtime-bundle/runtimes/node/lib/addon.node"),
    directory("Contents/Frameworks"),
    directory(FRAMEWORK),
    file(`${FRAMEWORK}/Versions/A/Electron Framework`),
    file(`${FRAMEWORK}/Versions/A/Libraries/libEGL.dylib`),
    file(`${FRAMEWORK}/Versions/A/Helpers/chrome_crashpad_handler`),
    file(`${FRAMEWORK}/Versions/A/Resources/info.plist`, false),
    directory("Contents/Frameworks/Squirrel.framework"),
    file("Contents/Frameworks/Squirrel.framework/Versions/A/Squirrel"),
    file("Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt"),
    directory(HELPER),
    file(`${HELPER}/Contents/MacOS/Work Intelligence Helper (GPU)`),
    directory("Contents/Frameworks/Mantle.framework/Versions/A/Frameworks/Nested.framework"),
  ];

  it("signs nested code, then frameworks, then helper apps, then the app", () => {
    expect(planSigningOrder(entries)).toEqual([
      `${FRAMEWORK}/Versions/A/Helpers/chrome_crashpad_handler`,
      `${FRAMEWORK}/Versions/A/Libraries/libEGL.dylib`,
      "Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt",
      `${FRAMEWORK}`,
      "Contents/Frameworks/Squirrel.framework",
      HELPER,
      ".",
    ]);
  });

  it("never plans the runtime bundle or any bundle's main executable", () => {
    const plan = planSigningOrder(entries);
    expect(plan.some((path) => path.includes("runtime-bundle"))).toBe(false);
    expect(plan).not.toContain("Contents/MacOS/Work Intelligence");
    expect(plan).not.toContain(`${FRAMEWORK}/Versions/A/Electron Framework`);
    expect(plan.some((path) => path.includes("Helper (GPU)/Contents/MacOS"))).toBe(false);
  });

  it("signs only the app when it holds no nested code", () => {
    expect(planSigningOrder([file("Contents/MacOS/Work Intelligence")])).toEqual(["."]);
  });
});

describe("app tree listing", () => {
  it("detects Mach-O files by content and never follows symbolic links", () => {
    const root = mkdtempSync(join(tmpdir(), "worklog-sign-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "Contents/Frameworks/A.framework/Versions/A"), { recursive: true });
    writeFileSync(join(root, "Contents/Frameworks/A.framework/Versions/A/lib.dylib"), header(0xcf, 0xfa, 0xed, 0xfe));
    writeFileSync(join(root, "Contents/Info.plist"), "<plist/>");
    symlinkSync("A", join(root, "Contents/Frameworks/A.framework/Versions/Current"));
    symlinkSync("..", join(root, "Contents/Loop"));

    const entries = listAppEntries(root);

    expect(entries).toContainEqual({
      path: "Contents/Frameworks/A.framework/Versions/A/lib.dylib",
      type: "file",
      machO: true,
    });
    expect(entries).toContainEqual({ path: "Contents/Info.plist", type: "file", machO: false });
    expect(entries.some((entry) => entry.path.includes("Current") || entry.path.includes("Loop"))).toBe(false);
  });
});
