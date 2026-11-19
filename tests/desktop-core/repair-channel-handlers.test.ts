import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPAIR_CHANNELS } from "../../packages/desktop-core/src/index.js";

/** Every repair channel has exactly one handler in main (the two pushed to the page excepted), and the preload exposes it. */
const PUSHED_TO_PAGE = new Set(["selectTab", "updateChanged"]);
const ipc = readFileSync(new URL("../../apps/desktop/src/main/ipc.ts", import.meta.url), "utf8");
const preload = readFileSync(new URL("../../apps/desktop/src/preload/repair.ts", import.meta.url), "utf8");

const rendererDir = new URL("../../apps/desktop/src/renderer/repair/", import.meta.url);
const renderer = readdirSync(rendererDir)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => readFileSync(new URL(name, rendererDir), "utf8"))
  .join("\n");

// The preload's `api` object: method name -> the channel key it forwards to.
const apiBody = preload.slice(preload.indexOf("const api: RepairApi"));
const methodChannel = new Map<string, string>();
for (const chunk of apiBody.split(/\n {2}(?=\w+: )/).slice(1)) {
  const method = /^(\w+):/.exec(chunk)?.[1];
  const channel = /channels\.(\w+)/.exec(chunk)?.[1];
  if (method && channel) methodChannel.set(method, channel);
}

describe("repair channel four-way cross-check (preload, REPAIR_CHANNELS, main handler, renderer call)", () => {
  it("parses the preload api", () => {
    expect(methodChannel.size).toBeGreaterThan(30);
  });

  for (const [key, value] of Object.entries(REPAIR_CHANNELS)) {
    it(`${key}: the preload spells the same channel and one method forwards it`, () => {
      expect(preload).toContain(`  ${key}: "${value}",`);
      expect([...methodChannel.values()].filter((channel) => channel === key)).not.toHaveLength(0);
    });
  }

  for (const [method, key] of methodChannel) {
    it(`${method} (${key}) is a real channel and the renderer calls it`, () => {
      expect(Object.keys(REPAIR_CHANNELS)).toContain(key);
      expect(renderer).toMatch(new RegExp(`\\b${method}\\b`));
    });
  }
});

describe("repair channel and handler pairing", () => {
  for (const key of Object.keys(REPAIR_CHANNELS)) {
    if (PUSHED_TO_PAGE.has(key)) continue;
    it(`${key} is handled in main`, () => {
      expect(ipc.match(new RegExp(`REPAIR_CHANNELS\\.${key}\\b`, "g"))?.length).toBe(1);
    });
  }

  it("lists the restore channels in the preload", () => {
    for (const key of ["restoreList", "restorePick", "restoreRun"]) expect(preload).toContain(key);
  });

  it("every lock holder in main names its action, so a busy answer can say what is running", () => {
    const all = ipc.match(/(?<!function )\b(?:withBusy|exclusive)\(/g)?.length ?? 0;
    const named = ipc.match(/(?<!function )\b(?:withBusy|exclusive)\(\s*"[a-z-]+"/g)?.length ?? 0;
    expect(all).toBeGreaterThan(5);
    expect(named).toBe(all);
    expect(ipc).toContain("state.busyAction = action");
  });
});
