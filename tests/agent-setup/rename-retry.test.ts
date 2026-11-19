import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeAtomically } from "../../packages/agent-setup/src/files.js";
import { createFixture, removeFixtures } from "./fixture.js";

// A Windows file lock (an antivirus scanner, the search indexer) refuses a rename for a moment. Only the rename of the
// temporary file over the target is refused here, as many times as `refusals` says.
const lock = vi.hoisted(() => ({ code: "EBUSY", refusals: 0, attempts: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (String(from).includes(".work-intelligence.tmp-")) {
        lock.attempts += 1;
        if (lock.refusals > 0) {
          lock.refusals -= 1;
          throw Object.assign(new Error(`${lock.code}: file is locked`), { code: lock.code });
        }
      }
      return actual.renameSync(from, to);
    },
  };
});

afterEach(() => {
  Object.assign(lock, { code: "EBUSY", refusals: 0, attempts: 0 });
  removeFixtures();
});

describe("writeAtomically under a Windows file lock", () => {
  it.each(["EBUSY", "EPERM", "EACCES"])("retries a brief %s and writes the file", (code) => {
    const target = join(createFixture().temporaryRoot, "settings.json");
    writeFileSync(target, "old");
    Object.assign(lock, { code, refusals: 2 });
    writeAtomically(target, Buffer.from("new"), 0o600);
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(lock.attempts).toBe(3);
  });

  it("gives up after five attempts and leaves the target as it was", () => {
    const target = join(createFixture().temporaryRoot, "settings.json");
    writeFileSync(target, "old");
    Object.assign(lock, { refusals: 99 });
    expect(() => writeAtomically(target, Buffer.from("new"), 0o600)).toThrow(/file is locked/);
    expect(lock.attempts).toBe(5);
    expect(readFileSync(target, "utf8")).toBe("old");
  });

  it("does not retry an error that is not a file lock", () => {
    const target = join(createFixture().temporaryRoot, "settings.json");
    Object.assign(lock, { code: "ENOSPC", refusals: 1 });
    expect(() => writeAtomically(target, Buffer.from("new"), 0o600)).toThrow(/locked/);
    expect(lock.attempts).toBe(1);
  });
});
