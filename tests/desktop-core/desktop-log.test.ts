import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../../apps/desktop/src/main/log.js";

const roots: string[] = [];

function paths() {
  const root = mkdtempSync(join(tmpdir(), "wi-log-"));
  roots.push(root);
  const logsDirectory = join(root, "logs");
  return { root, logsDirectory, logFile: join(logsDirectory, "desktop-main.log") };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the desktop log", () => {
  it("writes timestamped lines and creates its folder", () => {
    const where = paths();
    const log = createLogger(where);
    log("[shell] one");
    log("[shell] two");
    const lines = readFileSync(where.logFile, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z \[shell\] one$/);
  });

  // Windows has no POSIX modes; its files follow the folder's ACL.
  it.runIf(process.platform !== "win32")("creates the folder 0700 and the file 0600", () => {
    const where = paths();
    createLogger(where)("[shell] one");
    expect(statSync(where.logsDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(where.logFile).mode & 0o777).toBe(0o600);
  });

  it.runIf(process.platform !== "win32")("tightens a log an earlier version created with the default mode", () => {
    const where = paths();
    mkdirSync(where.logsDirectory);
    writeFileSync(where.logFile, "old line\n");
    chmodSync(where.logFile, 0o644);
    createLogger(where)("[shell] new");
    expect(statSync(where.logFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(where.logFile, "utf8")).toContain("old line");
  });

  it("creates the folder again when it was removed after the first line", () => {
    const where = paths();
    const log = createLogger(where);
    log("[shell] one");
    rmSync(where.logsDirectory, { recursive: true });
    log("[shell] two");
    expect(readFileSync(where.logFile, "utf8")).toContain("two");
  });
});
