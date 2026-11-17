import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSetupPlan } from "@work-intelligence/agent-setup";
import {
  ABSENT_FINGERPRINT,
  FingerprintMismatchError,
  displayPath,
  ensureDirectory,
  fingerprintOf,
  readCurrent,
  readRegularFile,
  removeAtomically,
  writeAtomically,
  writeExclusiveAtomically,
} from "../../packages/agent-setup/src/files.js";
import { createFixture, removeFixtures } from "./fixture.js";

afterEach(removeFixtures);

describe("file helpers", () => {
  it("fingerprints bytes with sha256 and a missing file as absent", () => {
    expect(fingerprintOf(null)).toBe(ABSENT_FINGERPRINT);
    expect(fingerprintOf(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("removes its temporary file when an atomic write cannot replace the target", () => {
    const fixture = createFixture();
    const target = join(fixture.temporaryRoot, "target");
    mkdirSync(target);
    expect(() => writeAtomically(target, Buffer.from("x"), 0o600)).toThrow();
    expect(readdirSync(fixture.temporaryRoot).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("replaces the target only while it still holds the expected bytes", () => {
    const fixture = createFixture();
    const target = join(fixture.temporaryRoot, "config.json");
    writeFileSync(target, "old");
    const expected = fingerprintOf(Buffer.from("old"));

    writeAtomically(target, Buffer.from("new"), 0o600, expected);
    expect(readFileSync(target, "utf8")).toBe("new");

    expect(() => writeAtomically(target, Buffer.from("newer"), 0o600, expected)).toThrow(FingerprintMismatchError);
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(readdirSync(fixture.temporaryRoot).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("removes a file only while it still holds the expected bytes", () => {
    const fixture = createFixture();
    const target = join(fixture.temporaryRoot, "config.json");
    writeFileSync(target, "edited");
    expect(() => removeAtomically(target, fingerprintOf(Buffer.from("old")))).toThrow(FingerprintMismatchError);
    expect(existsSync(target)).toBe(true);
    removeAtomically(target, fingerprintOf(Buffer.from("edited")));
    expect(existsSync(target)).toBe(false);
  });

  it("never replaces an existing file in an exclusive write and leaves no temporary file", () => {
    const fixture = createFixture();
    const target = join(fixture.temporaryRoot, "backup");
    writeFileSync(target, "original");
    expect(() => writeExclusiveAtomically(target, Buffer.from("x"))).toThrow();
    expect(readFileSync(target, "utf8")).toBe("original");
    expect(readdirSync(fixture.temporaryRoot).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("reports directories as unreadable and missing files as absent", () => {
    const fixture = createFixture();
    expect(readRegularFile(fixture.temporaryRoot).conflict).toContain("不是一般檔案");
    expect(() => readCurrent(fixture.temporaryRoot)).toThrow();
    expect(readCurrent(join(fixture.temporaryRoot, "missing"))).toBeNull();
  });

  it("records only the directories it created", () => {
    const fixture = createFixture();
    const created = new Set<string>();
    ensureDirectory(join(fixture.temporaryRoot, "a", "b"), created);
    expect([...created].sort()).toEqual([join(fixture.temporaryRoot, "a"), join(fixture.temporaryRoot, "a", "b")]);
    expect(existsSync(join(fixture.temporaryRoot, "a", "b"))).toBe(true);
  });
});

describe("setup manifest validation", () => {
  it.each([
    ["not json", "{ nope"],
    ["an array", "[]"],
    ["an unsupported version", JSON.stringify({ version: 9, components: [] })],
    ["an unknown component", JSON.stringify({ version: 2, components: [{ id: "x", kind: "file", expected: "a" }] })],
    [
      "a duplicate component",
      JSON.stringify({
        version: 2,
        components: [
          { id: "codexSkill", kind: "file", expected: "a" },
          { id: "codexSkill", kind: "file", expected: "a" },
        ],
      }),
    ],
    [
      "a version-one legacy skill record",
      JSON.stringify({ version: 1, components: [{ id: "codexLegacySkill", kind: "file", expected: "a" }] }),
    ],
    ["a non-string config directory", JSON.stringify({ version: 2, codexHomeDirectory: 3, components: [] })],
  ])("refuses to install over a manifest that is %s", (_name, content) => {
    const fixture = createFixture();
    writeFileSync(fixture.paths.manifest, content);
    const plan = createAgentSetupPlan(fixture.options);
    expect(plan.conflicts.length).toBeGreaterThan(0);
  });
});

describe("displayPath", () => {
  it("shortens paths under the home directory with the platform's separator", () => {
    expect(displayPath("/home/a/.codex/config.toml", "/home/a", "linux")).toBe("~/.codex/config.toml");
    expect(displayPath("/home/a", "/home/a", "linux")).toBe("~");
    expect(displayPath("/home/ab/x", "/home/a", "linux")).toBe("/home/ab/x");
    expect(displayPath("C:\\Users\\a\\.codex\\config.toml", "C:\\Users\\a", "win32")).toBe("~\\.codex\\config.toml");
    expect(displayPath("c:\\users\\A\\x", "C:\\Users\\a\\", "win32")).toBe("~\\x");
    expect(displayPath("C:\\Users\\a", "C:\\Users\\a", "win32")).toBe("~");
    expect(displayPath("C:\\Users\\ab\\x", "C:\\Users\\a", "win32")).toBe("C:\\Users\\ab\\x");
    expect(displayPath("D:\\other", "C:\\Users\\a", "win32")).toBe("D:\\other");
  });
});
