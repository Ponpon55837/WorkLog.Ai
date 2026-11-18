import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeAgentSetupJournal } from "../../packages/agent-setup/src/journal.js";
import { writeAtomically, writeExclusiveAtomically } from "../../packages/agent-setup/src/files.js";
import { createFixture, removeFixtures } from "./fixture.js";

// The package setup stubs `fsyncSync` for every other agent-setup test (see tests/helpers/skip-fsync.ts). This file
// re-registers `node:fs` with the real functions wrapped in recorders, so the crash-safety flushes stay guarded: if a
// future change drops the flush of the temporary file, or publishes it before the flush, these tests fail.
const events = vi.hoisted(() => [] as { call: "open" | "fsync" | "rename" | "link"; path: string }[]);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const pathOfDescriptor = new Map<number, string>();
  return {
    ...actual,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...args);
      pathOfDescriptor.set(descriptor, String(args[0]));
      return descriptor;
    }) as typeof actual.openSync,
    fsyncSync: (descriptor: number) => {
      events.push({ call: "fsync", path: pathOfDescriptor.get(descriptor) ?? "<unknown>" });
      return actual.fsyncSync(descriptor);
    },
    renameSync: (from: string, to: string) => {
      events.push({ call: "rename", path: String(from) });
      return actual.renameSync(from, to);
    },
    linkSync: (existing: string, created: string) => {
      events.push({ call: "link", path: String(existing) });
      return actual.linkSync(existing, created);
    },
  };
});

afterEach(() => {
  events.length = 0;
  removeFixtures();
});

const isTemporary = (path: string): boolean => path.includes(".tmp-");

/** The temporary file must be flushed before the call that publishes it; returns the flushed path. */
function expectTemporaryFlushedBeforePublish(publish: "rename" | "link"): string {
  const publishIndex = events.findIndex((event) => event.call === publish);
  expect(publishIndex).toBeGreaterThan(-1);
  const published = events[publishIndex]!.path;
  expect(isTemporary(published)).toBe(true);
  const flushIndex = events.findIndex((event) => event.call === "fsync" && event.path === published);
  expect(flushIndex).toBeGreaterThan(-1);
  expect(flushIndex).toBeLessThan(publishIndex);
  return published;
}

describe("agent-setup crash-safety flushes", () => {
  it("flushes the temporary file before renaming it over the target, then the directory where one can be opened", () => {
    const fixture = createFixture();
    const target = join(fixture.temporaryRoot, "flush-target.json");

    writeAtomically(target, Buffer.from("{}\n"), 0o600);

    expectTemporaryFlushedBeforePublish("rename");
    const flushedDirectories = events.filter((event) => event.call === "fsync" && event.path === dirname(target));
    // Windows cannot open a directory, so syncDirectory is a documented no-op there.
    expect(flushedDirectories).toHaveLength(process.platform === "win32" ? 0 : 1);
    if (process.platform !== "win32") {
      const renameIndex = events.findIndex((event) => event.call === "rename");
      expect(events.indexOf(flushedDirectories[0]!)).toBeGreaterThan(renameIndex);
    }
  });

  it("flushes the temporary file before linking it into place for an exclusive write", () => {
    const fixture = createFixture();
    writeExclusiveAtomically(join(fixture.temporaryRoot, "exclusive-target.json"), Buffer.from("{}\n"));

    expectTemporaryFlushedBeforePublish("link");
  });

  it("flushes the journal's temporary file before renaming it over the journal", () => {
    const fixture = createFixture();
    writeAgentSetupJournal(fixture.paths.journal, {
      version: 1,
      operationId: "synthetic-operation",
      state: "committed",
      startedAt: "2026-09-28T12:34:56.000Z",
      items: [],
      createdDirectories: [],
    });

    const flushed = expectTemporaryFlushedBeforePublish("rename");
    expect(flushed.startsWith(fixture.paths.journal)).toBe(true);
  });
});
