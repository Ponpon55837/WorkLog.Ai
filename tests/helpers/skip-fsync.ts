import { vi } from "vitest";

// agent-setup flushes every file it writes (a deliberate crash-safety step: temp file, fsync, rename). Inside one live
// process a flush has no observable effect, so the tests would only pay the disk's flush latency: a few hundred
// milliseconds on a busy Windows runner, which pushed whole synchronous tests past their 5 s limit. The product code is
// unchanged; the tests keep every assertion about what is on disk after the rename.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: () => undefined };
});
