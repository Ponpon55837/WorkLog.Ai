import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configDirectory,
  databasePathFor,
  linkedRepositoryRoot,
  STANDALONE,
  standaloneDatabasePath,
} from "../../apps/mcp/src/database-location.js";

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
    expect(databasePathFor("/repo/data/work-intelligence.sqlite", { environment: {}, home })).toBe(
      "/repo/data/work-intelligence.sqlite",
    );
    expect(
      databasePathFor("/repo/data/x.sqlite", { environment: { WORK_INTELLIGENCE_DB: "/custom.sqlite" }, home }),
    ).toBe("/custom.sqlite");
  });

  it("opens the user's data directory when the bundle has no checkout", () => {
    const home = temporaryDirectory();
    expect(databasePathFor("/bundle/data/x.sqlite", { standalone: true, environment: {}, home })).toBe(
      join(home, ".work-intelligence", "data", "work-intelligence.sqlite"),
    );
    expect(configDirectory({ environment: { WORK_INTELLIGENCE_CONFIG_DIR: " /config " }, home })).toBe("/config");
    expect(standaloneDatabasePath({ environment: { WORK_INTELLIGENCE_CONFIG_DIR: "/config" }, home })).toBe(
      join("/config", "data", "work-intelligence.sqlite"),
    );
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
    ).toBe("/explicit.sqlite");
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
