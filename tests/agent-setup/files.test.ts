import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSetupPlan } from "@work-intelligence/agent-setup";
import {
  ABSENT_FINGERPRINT,
  ensureDirectory,
  fingerprintOf,
  readCurrent,
  readRegularFile,
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
