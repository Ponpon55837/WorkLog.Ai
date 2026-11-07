import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configDirectory,
  databasePathFor,
  linkedRepositoryRoot,
  STANDALONE,
  standaloneDatabasePath,
} from "../../packages/shared/src/database-location.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "work-intelligence-db-location-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeCheckout(root: string): string {
  mkdirSync(join(root, "apps/mcp"), { recursive: true });
  writeFileSync(join(root, "pnpm-workspace.yaml"), "");
  writeFileSync(join(root, "apps/mcp/package.json"), "{}");
  return root;
}

function link(home: string, repositoryRoot: unknown): void {
  mkdirSync(join(home, ".work-intelligence"), { recursive: true });
  writeFileSync(join(home, ".work-intelligence/plugin-link.json"), JSON.stringify({ repositoryRoot }));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("database location", () => {
  it("is not standalone in the repository build", () => {
    expect(STANDALONE).toBe(false);
  });

  it("keeps the repository build on WORK_INTELLIGENCE_DB or the checkout's data/, ignoring any plugin link", () => {
    const home = temporaryDirectory();
    link(home, fakeCheckout(join(home, "elsewhere")));
    expect(databasePathFor("/repo", { environment: {}, home })).toBe(
      resolve("/repo", "data", "work-intelligence.sqlite"),
    );
    expect(databasePathFor("/repo", { environment: { WORK_INTELLIGENCE_DB: "/custom.sqlite" }, home })).toBe(
      resolve("/custom.sqlite"),
    );
  });

  it("resolves a relative database setting from the repository root, not the working directory", () => {
    expect(databasePathFor("/repo", { environment: { WORK_INTELLIGENCE_DB: "data/other.sqlite" } })).toBe(
      resolve("/repo", "data/other.sqlite"),
    );
    expect(databasePathFor("/repo", { environment: { WORK_INTELLIGENCE_DB: "  " } })).toBe(
      resolve("/repo", "data", "work-intelligence.sqlite"),
    );
  });

  it.skipIf(process.platform !== "win32")("rejects a drive-relative database setting", () => {
    expect(() =>
      databasePathFor("/repo", { environment: { WORK_INTELLIGENCE_DB: "C:Users\\fixture\\x.sqlite" } }),
    ).toThrow("磁碟相對路徑");
    expect(() =>
      standaloneDatabasePath({ environment: { WORK_INTELLIGENCE_DB: "C:fixture.sqlite" }, home: "/fixture-home" }),
    ).toThrow("磁碟相對路徑");
  });

  it("opens the user's data directory when the bundle has no checkout", () => {
    const home = temporaryDirectory();
    expect(databasePathFor("/bundle", { standalone: true, environment: {}, home })).toBe(
      join(home, ".work-intelligence", "data", "work-intelligence.sqlite"),
    );
    expect(configDirectory({ environment: { WORK_INTELLIGENCE_CONFIG_DIR: " /config " }, home })).toBe("/config");
    expect(standaloneDatabasePath({ environment: { WORK_INTELLIGENCE_CONFIG_DIR: "/config" }, home })).toBe(
      join("/config", "data", "work-intelligence.sqlite"),
    );
  });

  it("resolves a relative database setting from the config directory in standalone mode, not the repository or cwd", () => {
    const home = temporaryDirectory();
    const base = join(home, ".work-intelligence");
    expect(
      databasePathFor("/bundle", {
        standalone: true,
        environment: { WORK_INTELLIGENCE_DB: "data/other.sqlite" },
        home,
      }),
    ).toBe(resolve(base, "data/other.sqlite"));
    expect(
      databasePathFor("/bundle", {
        standalone: true,
        environment: { WORK_INTELLIGENCE_DB: "../x.sqlite", WORK_INTELLIGENCE_CONFIG_DIR: join(home, "cfg") },
        home,
      }),
    ).toBe(resolve(home, "x.sqlite"));
    expect(
      databasePathFor("/bundle", { standalone: true, environment: { WORK_INTELLIGENCE_DB: " :memory: " }, home }),
    ).toBe(":memory:");
  });

  it("keeps absolute database settings unchanged in both modes", () => {
    const absolute = join(temporaryDirectory(), "abs.sqlite");
    for (const standalone of [false, true]) {
      expect(
        databasePathFor("/repo", { standalone, environment: { WORK_INTELLIGENCE_DB: ` ${absolute} ` }, home: "/h" }),
      ).toBe(absolute);
    }
  });

  it("applies Windows path rules when asked", () => {
    const options = { platform: "win32" as const, home: "C:\\Users\\fixture" };
    const database = (standalone: boolean, value?: string): string =>
      databasePathFor("C:\\repo", { ...options, standalone, environment: { WORK_INTELLIGENCE_DB: value } });
    expect(database(false)).toBe("C:\\repo\\data\\work-intelligence.sqlite");
    expect(database(false, "db\\a.sqlite")).toBe("C:\\repo\\db\\a.sqlite");
    expect(database(true)).toBe("C:\\Users\\fixture\\.work-intelligence\\data\\work-intelligence.sqlite");
    expect(database(true, "db\\a.sqlite")).toBe("C:\\Users\\fixture\\.work-intelligence\\db\\a.sqlite");
    expect(database(true, "D:\\other\\a.sqlite")).toBe("D:\\other\\a.sqlite");
    expect(() => database(true, "C:a.sqlite")).toThrow("磁碟相對路徑");
  });

  it("shares the linked checkout's database with the Web UI", () => {
    const home = temporaryDirectory();
    const checkout = fakeCheckout(join(home, "checkout"));
    link(home, checkout);
    expect(standaloneDatabasePath({ environment: {}, home })).toBe(join(checkout, "data", "work-intelligence.sqlite"));
    const other = fakeCheckout(join(home, "other"));
    expect(linkedRepositoryRoot({ environment: { WORK_INTELLIGENCE_HOME: other }, home })).toBe(other);
    expect(
      standaloneDatabasePath({
        environment: { WORK_INTELLIGENCE_DB: " /explicit.sqlite ", WORK_INTELLIGENCE_HOME: other },
        home,
      }),
    ).toBe(resolve(join(home, ".work-intelligence"), "/explicit.sqlite"));
  });

  it("ignores an empty database setting and links that no longer point at a checkout", () => {
    const home = temporaryDirectory();
    const fallback = join(home, ".work-intelligence", "data", "work-intelligence.sqlite");
    expect(standaloneDatabasePath({ environment: { WORK_INTELLIGENCE_DB: "  " }, home })).toBe(fallback);
    link(home, join(home, "deleted"));
    expect(standaloneDatabasePath({ environment: {}, home })).toBe(fallback);
    link(home, "");
    expect(linkedRepositoryRoot({ environment: {}, home })).toBeUndefined();
    writeFileSync(join(home, ".work-intelligence/plugin-link.json"), "not json");
    expect(
      linkedRepositoryRoot({ environment: { WORK_INTELLIGENCE_HOME: join(home, "missing") }, home }),
    ).toBeUndefined();
  });
});
