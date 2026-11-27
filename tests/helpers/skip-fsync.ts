import { vi } from "vitest";

// agent-setup fsyncs every file it writes (crash safety). In one live process that has no observable effect and only costs flush latency, which pushed tests past their 5 s limit on a busy Windows runner.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: () => undefined };
});
