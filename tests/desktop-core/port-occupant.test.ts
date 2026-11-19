import { describe, expect, it } from "vitest";
import { isSameDatabaseServer } from "../../packages/desktop-core/src/shell/port-occupant.js";

// Synthetic status bodies and paths only; nothing listens on a real port here.
const DB = "/synthetic/data/work.sqlite";
const status = (path: unknown, version: unknown = "1.6.60") => ({ version, database: { path } });
const probe = (body: unknown, extra: Partial<Parameters<typeof isSameDatabaseServer>[0]> = {}) =>
  isSameDatabaseServer({
    port: 43_100,
    databasePath: DB,
    fetchStatus: async () => body,
    realPath: async (path) => path,
    ...extra,
  });

describe("isSameDatabaseServer", () => {
  it("is true only for a Work Intelligence status that names the same database file", async () => {
    expect(await probe(status(DB))).toBe(true);
    expect(await probe(status("/synthetic/data/other.sqlite"))).toBe(false);
  });

  it("compares real paths, so a link and its target are one database", async () => {
    const realPath = async (path: string) => (path === "/synthetic/link.sqlite" ? DB : path);
    expect(await probe(status("/synthetic/link.sqlite"), { realPath })).toBe(true);
  });

  it("keeps an unresolvable path as it is", async () => {
    const realPath = async () => {
      throw new Error("missing");
    };
    expect(await probe(status(DB), { realPath })).toBe(true);
    expect(await probe(status("/synthetic/data/other.sqlite"), { realPath })).toBe(false);
  });

  it("ignores case and separators on Windows only", async () => {
    const win = (path: string) => probe(status(path), { databasePath: "C:\\Data\\Work.sqlite", platform: "win32" });
    expect(await win("c:/data/work.sqlite")).toBe(true);
    expect(await probe(status("/Synthetic/Data/Work.sqlite"), { platform: "linux" })).toBe(false);
  });

  it("is false for anything that is not that status: silence, an error, another shape", async () => {
    for (const body of [
      undefined,
      null,
      "text",
      {},
      { version: "1" },
      status(7),
      status(DB, 3),
      { version: "1", database: null },
    ]) {
      expect(await probe(body)).toBe(false);
    }
    expect(
      await isSameDatabaseServer({
        port: 43_100,
        databasePath: DB,
        fetchStatus: async () => {
          throw new Error("connection refused");
        },
      }),
    ).toBe(false);
  });

  it("asks the loopback status endpoint with a short deadline by default", async () => {
    const asked: Array<{ url: string; timeoutMs: number }> = [];
    await isSameDatabaseServer({
      port: 43_100,
      databasePath: DB,
      fetchStatus: async (url, timeoutMs) => {
        asked.push({ url, timeoutMs });
        return undefined;
      },
    });
    expect(asked).toEqual([{ url: "http://127.0.0.1:43100/api/system/status", timeoutMs: 1500 }]);
  });

  it("answers false for a port nothing listens on, using the real fetch and realpath", async () => {
    expect(await isSameDatabaseServer({ port: 1, databasePath: DB })).toBe(false);
  });
});
