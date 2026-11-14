import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkIntelligenceStore } from "../../packages/storage/src/index.js";

const posixOnly = it.skipIf(process.platform === "win32");
const directories: string[] = [];

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "wi-permissions-"));
  directories.push(directory);
  return directory;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function withUmask<T>(value: number, run: () => T): T {
  const previous = process.umask(value);
  try {
    return run();
  } finally {
    process.umask(previous);
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("database file permissions", () => {
  posixOnly("creates a private data directory and database files under umask 022", () => {
    const root = temporaryRoot();
    const databasePath = join(root, "data", "wi.sqlite");
    withUmask(0o022, () => {
      const store = new WorkIntelligenceStore(databasePath);
      try {
        expect(mode(join(root, "data"))).toBe(0o700);
        expect(mode(databasePath)).toBe(0o600);
        for (const suffix of ["-wal", "-shm"]) {
          if (existsSync(databasePath + suffix)) expect(mode(databasePath + suffix)).toBe(0o600);
        }
      } finally {
        store.close();
      }
    });
  });

  posixOnly("only makes directories it created private and leaves existing parents alone", () => {
    const root = temporaryRoot();
    chmodSync(root, 0o755);
    withUmask(0o022, () => {
      const store = new WorkIntelligenceStore(join(root, "a", "b", "wi.sqlite"));
      store.close();
    });
    expect(mode(root)).toBe(0o755);
    expect(mode(join(root, "a"))).toBe(0o700);
    expect(mode(join(root, "a", "b"))).toBe(0o700);
  });

  posixOnly("tightens a wider existing database and keeps its existing directory", () => {
    const root = temporaryRoot();
    const directory = join(root, "data");
    const databasePath = join(directory, "wi.sqlite");
    withUmask(0o022, () => {
      new WorkIntelligenceStore(databasePath).close();
      chmodSync(databasePath, 0o644);
      chmodSync(directory, 0o755);
      const store = new WorkIntelligenceStore(databasePath);
      try {
        expect(mode(databasePath)).toBe(0o600);
        for (const suffix of ["-wal", "-shm"]) {
          if (existsSync(databasePath + suffix)) expect(mode(databasePath + suffix)).toBe(0o600);
        }
        expect(mode(directory)).toBe(0o755);
      } finally {
        store.close();
      }
    });
  });

  posixOnly("does not create files for an in-memory store", () => {
    const root = temporaryRoot();
    const previous = process.cwd();
    process.chdir(root);
    try {
      new WorkIntelligenceStore(":memory:").close();
      expect(existsSync(join(root, ":memory:"))).toBe(false);
    } finally {
      process.chdir(previous);
    }
  });

  posixOnly("accepts a pre-existing empty directory without changing it", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "data"), { mode: 0o755 });
    chmodSync(join(root, "data"), 0o755);
    writeFileSync(join(root, "unrelated.txt"), "x");
    new WorkIntelligenceStore(join(root, "data", "wi.sqlite")).close();
    expect(mode(join(root, "data"))).toBe(0o755);
  });
});
