import path from "node:path";
import { describe, expect, it } from "vitest";
import { lastSegment, missingRoots, planRelocation, remapList } from "../../packages/desktop-core/src/index.js";

describe("restore relocation", () => {
  it("reads the last segment of a path written on either OS", () => {
    expect(lastSegment("/Users/me/work/alpha/")).toBe("alpha");
    expect(lastSegment("C:\\Users\\me\\work\\alpha")).toBe("alpha");
    expect(lastSegment("alpha")).toBe("alpha");
  });

  it("finds the roots that are not here, checking them in bounded batches", async () => {
    const roots = Array.from({ length: 200 }, (_, index) => ({ path: `/old/p${index}`, name: `p${index}` }));
    let live = 0;
    let peak = 0;
    const missing = await missingRoots(roots, async (path) => {
      live += 1;
      peak = Math.max(peak, live);
      await Promise.resolve();
      live -= 1;
      return path.endsWith("0");
    });
    expect(missing).toHaveLength(180);
    expect(peak).toBeLessThanOrEqual(64);
  });

  it("matches the chosen folder itself or a folder of the same name inside it", async () => {
    const missing = [
      { path: "C:\\Users\\old\\work\\alpha", name: "alpha" },
      { path: "C:\\Users\\old\\work\\beta", name: "beta" },
      { path: "C:\\Users\\old\\work\\gamma", name: "gamma" },
    ];
    const inside = await planRelocation({
      missing,
      chosen: "/Users/new/work",
      directoryExists: async (folder) => folder.endsWith("alpha") || folder.endsWith("beta"),
      caseInsensitive: false,
    });
    expect([...inside]).toEqual([
      ["C:\\Users\\old\\work\\alpha", path.join("/Users/new/work", "alpha")],
      ["C:\\Users\\old\\work\\beta", path.join("/Users/new/work", "beta")],
    ]);
    const itself = await planRelocation({
      missing,
      chosen: "/Users/new/Beta",
      directoryExists: async () => false,
      caseInsensitive: true,
    });
    expect([...itself]).toEqual([["C:\\Users\\old\\work\\beta", "/Users/new/Beta"]]);
  });

  it("orders the remap longest source first so a nested project is moved before its parent", () => {
    const list = remapList(
      new Map([
        ["/old/work", "/new/work"],
        ["/old/work/nested/app", "/new/app"],
      ]),
    );
    expect(list.map((entry) => entry.from)).toEqual(["/old/work/nested/app", "/old/work"]);
  });
});

describe("restore relocation when a probe throws", () => {
  it("treats a root whose existence check throws as missing", async () => {
    const roots = [{ path: "/old/a", name: "a" }];
    const missing = await missingRoots(roots, async () => {
      throw new Error("offline drive");
    });
    expect(missing).toEqual(roots);
  });

  it("leaves a project unmapped when looking inside the chosen folder throws", async () => {
    const mapped = await planRelocation({
      missing: [{ path: "/old/alpha", name: "alpha" }],
      chosen: "/new/projects",
      caseInsensitive: false,
      directoryExists: async () => {
        throw new Error("offline drive");
      },
    });
    expect(mapped.size).toBe(0);
  });
});
