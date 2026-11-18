import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPAIR_CHANNELS } from "../../packages/desktop-core/src/index.js";

/** Every repair channel has exactly one handler in main (the two pushed to the page excepted), and the preload exposes it. */
const PUSHED_TO_PAGE = new Set(["selectTab", "updateChanged"]);
const ipc = readFileSync(new URL("../../apps/desktop/src/main/ipc.ts", import.meta.url), "utf8");
const preload = readFileSync(new URL("../../apps/desktop/src/preload/repair.ts", import.meta.url), "utf8");

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
