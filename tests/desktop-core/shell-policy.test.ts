import { describe, expect, it, vi } from "vitest";
import {
  BackendRecovery,
  buildDiagnostics,
  buildRepairState,
  createRedactor,
  databaseStatusFor,
  displayPath,
  ErrorPresenter,
  isDashboardUrl,
  isDeterministicFailure,
  isTrustedRepairSender,
  databaseKey,
  LastBackupTracker,
  type LastBackupInfo,
  joinBackupPath,
  readLastBackupFromDirectory,
  RecentErrors,
  REPAIR_ASSETS,
  REPAIR_CHANNELS,
  REPAIR_CSP,
  repairInputSchemas,
  resolveRepairAsset,
  RestartPolicy,
  type BackendRecoveryDeps,
  type RestartOutcome,
} from "../../packages/desktop-core/src/index.js";

describe("navigation policy", () => {
  it("serves only the four fixed assets and the page for /", () => {
    expect([...REPAIR_ASSETS.keys()].sort()).toEqual(["/index.html", "/repair.css", "/repair.js", "/tokens.css"]);
    expect(resolveRepairAsset("wi-repair://app/tokens.css")?.contentType).toBe("text/css; charset=utf-8");
    expect(resolveRepairAsset("wi-repair://app/")?.file).toBe("index.html");
    expect(resolveRepairAsset("wi-repair://app/repair.js")?.contentType).toContain("javascript");
    expect(resolveRepairAsset("wi-repair://app/repair.css?x=1#y")?.file).toBe("repair.css");
  });

  it.each([
    "wi-repair://app/../secret",
    "wi-repair://app/%2e%2e/secret",
    "wi-repair://app/repair.js/",
    "wi-repair://app/other.js",
    "wi-repair://app/index.html/../../etc/passwd",
    "wi-repair://evil/index.html",
    "wi-repair://user@app/index.html",
    "wi-repair://app:8080/index.html",
    "wi-repair2://app/index.html",
    "file:///etc/passwd",
    "https://app/index.html",
    "not a url",
    "",
  ])("refuses %s", (url) => {
    expect(resolveRepairAsset(url)).toBeUndefined();
  });

  it("allows the Dashboard only on the loopback address with the exact active port", () => {
    expect(isDashboardUrl("http://127.0.0.1:41000/", 41_000)).toBe(true);
    expect(isDashboardUrl("http://127.0.0.1:41000/projects?a=1", 41_000)).toBe(true);
    for (const bad of [
      "http://127.0.0.1:41001/",
      "http://127.0.0.1/",
      "http://localhost:41000/",
      "http://user:pw@127.0.0.1:41000/",
      "http://127.0.0.1.evil.test:41000/",
      "https://127.0.0.1:41000/",
      "http://[::1]:41000/",
      "http://127.0.0.1:41000@evil.test/",
    ]) {
      expect(isDashboardUrl(bad, 41_000)).toBe(false);
    }
    expect(isDashboardUrl("http://127.0.0.1:41000/", null)).toBe(false);
  });

  it("pins the CSP", () => {
    expect(REPAIR_CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  });
});

describe("repair IPC", () => {
  it("accepts only the repair page in the repair window's main frame", () => {
    const ok = { frameUrl: "wi-repair://app/index.html", isMainFrame: true, fromRepairWindow: true };
    expect(isTrustedRepairSender(ok)).toBe(true);
    expect(isTrustedRepairSender({ ...ok, isMainFrame: false })).toBe(false);
    expect(isTrustedRepairSender({ ...ok, fromRepairWindow: false })).toBe(false);
    expect(isTrustedRepairSender({ ...ok, frameUrl: "http://127.0.0.1:41000/" })).toBe(false);
    expect(isTrustedRepairSender({ ...ok, frameUrl: "wi-repair://evil/index.html" })).toBe(false);
  });

  it("validates every input strictly", () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    expect(repairInputSchemas.retryStart.safeParse({ operationId: uuid }).success).toBe(true);
    expect(repairInputSchemas.retryStart.safeParse({ operationId: "x" }).success).toBe(false);
    expect(repairInputSchemas.retryStart.safeParse({ operationId: uuid, path: "/etc" }).success).toBe(false);
    expect(repairInputSchemas.chooseDatabase.safeParse({ path: "/etc/passwd" }).success).toBe(false);
    expect(repairInputSchemas.chooseDatabase.safeParse({}).success).toBe(true);
    expect(repairInputSchemas.confirmDatabase.safeParse({ candidateId: "c1" }).success).toBe(true);
    expect(repairInputSchemas.confirmDatabase.safeParse({ candidateId: "c1", allowMigration: true }).success).toBe(
      true,
    );
    expect(repairInputSchemas.confirmDatabase.safeParse({ candidateId: "c1", allowMigration: "yes" }).success).toBe(
      false,
    );
    expect(repairInputSchemas.confirmDatabase.safeParse({ candidateId: "c1", path: "/x" }).success).toBe(false);
    expect(repairInputSchemas.confirmDatabase.safeParse({ candidateId: "" }).success).toBe(false);
    expect(repairInputSchemas.openFolder.safeParse({ target: "logs" }).success).toBe(true);
    expect(repairInputSchemas.openFolder.safeParse({ target: "/etc" }).success).toBe(false);
    expect(repairInputSchemas.openFolder.safeParse({ target: "database", extra: 1 }).success).toBe(false);
    expect(repairInputSchemas.setupCopyToLocal.safeParse({ sourceId: "s1", launchAtLogin: true }).success).toBe(true);
    expect(repairInputSchemas.setupCopyToLocal.safeParse({ sourceId: "s1", path: "/x" }).success).toBe(false);
    expect(repairInputSchemas.setupCopyToLocal.safeParse({ sourceId: "" }).success).toBe(false);
    expect(repairInputSchemas.getState.safeParse(undefined).success).toBe(true);
    expect(repairInputSchemas.previewDiagnostics.safeParse({ path: "/x" }).success).toBe(false);
    expect(repairInputSchemas.previewDiagnostics.safeParse({}).success).toBe(true);
    const previewId = "6f1c1c0e-5b53-4c53-9a53-0c9d2b7a1f11";
    expect(repairInputSchemas.saveDiagnostics.safeParse({ previewId }).success).toBe(true);
    expect(repairInputSchemas.saveDiagnostics.safeParse({ previewId, text: "x" }).success).toBe(false);
    expect(repairInputSchemas.saveDiagnostics.safeParse({ previewId, path: "/x" }).success).toBe(false);
    expect(repairInputSchemas.saveDiagnostics.safeParse({ previewId: "not-an-id" }).success).toBe(false);
    expect(repairInputSchemas.saveDiagnostics.safeParse({}).success).toBe(false);
  });

  it("names its channels and action ids", () => {
    expect(Object.values(REPAIR_CHANNELS).sort()).toEqual([
      "agents:apply",
      "agents:discard",
      "agents:get-state",
      "agents:preview",
      "agents:remove-preview",
      "agents:self-test",
      "agents:undo",
      "agents:use-checkout-database",
      "app:get-tab",
      "app:open-system-settings",
      "app:recovery-acknowledge",
      "app:remember-tab",
      "app:select-tab",
      "app:show-view",
      "legacy:disable-confirm",
      "legacy:disable-preview",
      "legacy:recheck",
      "legacy:start-now",
      "login-item:set",
      "port:change",
      "repair:choose-database",
      "repair:confirm-database",
      "repair:copy-to-local",
      "repair:get-state",
      "repair:open-folder",
      "repair:preview-diagnostics",
      "repair:retry-start",
      "repair:save-diagnostics",
      "repair:start-anyway",
      "restore:list",
      "restore:pick",
      "restore:run",
      "setup:choose-file",
      "setup:copy-to-local",
      "setup:get-state",
      "setup:later",
      "setup:use-defaults",
      "setup:use-source",
      "update:changed",
      "update:check",
      "update:open-link",
    ]);
  });
});

describe("repair state", () => {
  const base = {
    platform: "linux" as const,
    homeDirectory: "/synthetic/home/someone",
    locale: "en" as const,
    owner: "NEEDS_REPAIR" as const,
    backend: "stopped" as const,
    databasePath: "/synthetic/home/someone/data/work.sqlite",
    databaseStatus: "missing" as const,
    candidates: [
      { id: "c1", path: "/synthetic/home/someone/other.sqlite", status: "unknown" as const },
      { id: "c2", path: "/synthetic/home/someone/ok.sqlite", status: "ok" as const, needsMigration: true },
    ],
    recentErrors: [{ code: "DB_MISSING", at: "2026-01-01T00:00:00.000Z" }],
    lastBackup: { status: "none" as const },
    retryOperationId: "123e4567-e89b-42d3-a456-426614174000",
    busy: false,
  };

  it("shows the home as ~ and never carries a real path", () => {
    const state = buildRepairState(base);
    expect(state.database.display).toBe("~/data/work.sqlite");
    expect(state.candidates[0]?.display).toBe("~/other.sqlite");
    expect(JSON.stringify(state)).not.toContain("/synthetic/home");
  });

  it("lets only a database whose preview said ok be confirmed, and flags one that needs a schema update", () => {
    const [unknown, ok] = buildRepairState(base).candidates;
    expect(unknown).toMatchObject({ canConfirm: false, needsMigration: false });
    expect(ok).toMatchObject({ canConfirm: true, needsMigration: true });
  });

  it.each([
    [true, undefined, "ok"],
    [false, "DB_MISSING", "missing"],
    [false, "DB_OFFLINE", "offline"],
    [false, "DB_PERMISSION", "denied"],
    [false, "SCHEMA_TOO_NEW", "unsupported-schema"],
    [false, "CHILD_EXITED", "unknown"],
    [false, undefined, "unknown"],
  ])("derives the database status (running %s, latest error %s)", (running, code, expected) => {
    expect(databaseStatusFor(running, code)).toBe(expected);
  });

  it("enables retry unless a managed service already runs, and disables everything while busy", () => {
    const enabled = (state: ReturnType<typeof buildRepairState>, id: string) =>
      state.actions.find((action) => action.id === id)?.enabled;
    expect(enabled(buildRepairState(base), "retry-start")).toBe(true);
    expect(enabled(buildRepairState({ ...base, owner: "MANAGED", backend: "running" }), "retry-start")).toBe(false);
    const busy = buildRepairState({ ...base, busy: true });
    expect(enabled(busy, "retry-start")).toBe(false);
    expect(enabled(busy, "choose-database")).toBe(false);
    expect(enabled(buildRepairState({ ...base, databasePath: null }), "open-database-folder")).toBe(false);
    expect(buildRepairState({ ...base, databasePath: null }).database.display).toBeNull();
  });

  it("masks the home case-insensitively with either slash on Windows, and leaves other paths alone", () => {
    expect(displayPath("c:/users/Me/data.sqlite", "C:\\Users\\me", "win32")).toBe("~/data.sqlite");
    expect(displayPath("C:\\Users\\ME", "C:\\Users\\me\\", "win32")).toBe("~");
    expect(displayPath("D:\\other\\a.sqlite", "C:\\Users\\me", "win32")).toBe("D:\\other\\a.sqlite");
    expect(displayPath("/synthetic/homework/a", "/synthetic/home", "linux")).toBe("/synthetic/homework/a");
    expect(displayPath("/a", "/", "linux")).toBe("/a");
  });
});

describe("RecentErrors", () => {
  it("keeps only the newest entries", () => {
    const errors = new RecentErrors(2);
    for (const code of ["A", "B", "C"]) errors.record(code, new Date(Date.UTC(2026, 0, 1)));
    expect(errors.list().map((entry) => entry.code)).toEqual(["B", "C"]);
    expect(errors.latest()?.code).toBe("C");
    expect(new RecentErrors().latest()).toBeUndefined();
    expect(() => new RecentErrors(0)).toThrow(RangeError);
  });
});

describe("diagnostics redaction", () => {
  const secrets = {
    token: ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_"),
    patToken: ["github", "pat", "11ABCDEFG0abcdefghijklmnop_qrstuvwxyz"].join("_"),
    sk: ["sk", "proj", "abcdefghijklmnopqrstuvwxyz"].join("-"),
    bearer: "Bearer abc.def-ghi_jkl123456",
    runId: "synthetic-run-id-0123456789abcdef",
    long: "A".repeat(20) + "b".repeat(20),
    hex: "0123456789abcdef".repeat(4),
    password: "hunter2-synthetic",
    cookie: "sessionid=zzz999synthetic",
  };

  function build(platform: NodeJS.Platform, extras: Partial<Parameters<typeof buildDiagnostics>[0]> = {}): string {
    const home = platform === "win32" ? "C:\\Users\\Someone" : "/synthetic/home/someone";
    const dbPath =
      platform === "win32" ? "C:\\Users\\Someone\\AppData\\work.sqlite" : "/synthetic/home/someone/work.sqlite";
    return buildDiagnostics({
      platform,
      homeDirectory: home,
      userName: "someone",
      paths: [dbPath, "D:\\Backups (x86)\\daily"],
      secrets: [secrets.runId],
      appVersion: "1.2.3",
      arch: "x64",
      locale: "en-US",
      owner: "NEEDS_REPAIR",
      backend: "crashed",
      databaseStatus: "missing",
      recentErrors: [{ code: "DB_MISSING", at: "2026-01-01T00:00:00.000Z" }],
      lastBackup: { status: "none" },
      generatedAt: new Date(Date.UTC(2026, 0, 2)),
      recentOutput: [
        `opening ${dbPath} for someone`,
        `token=${secrets.token} and ${secrets.patToken}`,
        `key ${secrets.sk}`,
        `Authorization: ${secrets.bearer}`,
        `run ${secrets.runId}`,
        `blob ${secrets.long} and ${secrets.hex}`,
        `{"password":"${secrets.password}","api_key": "${secrets.sk}"}`,
        `Cookie: ${secrets.cookie}`,
        "D:\\Backups (x86)\\daily\\a.sqlite and d:/backups (X86)/daily/b",
      ].map((line) => `[shell] ${line}`), // only the App's own lines are kept; the secrets are in them
      ...extras,
    }).text;
  }

  it.each(["linux", "win32"] as const)("contains none of the injected secrets or paths on %s", (platform) => {
    const text = build(platform);
    for (const secret of [
      secrets.token,
      secrets.patToken,
      secrets.sk,
      "abc.def-ghi_jkl123456",
      secrets.runId,
      secrets.long,
      secrets.hex,
      secrets.password,
      "zzz999synthetic",
      "someone",
      "Someone",
      "Backups (x86)",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/\/synthetic\/home|C:\\\\Users|AppData/i);
    expect(JSON.parse(text)).toMatchObject({ app: { version: "1.2.3" }, state: { owner: "NEEDS_REPAIR" } });
  });

  it("keeps the harmless facts", () => {
    const text = build("linux");
    expect(text).toContain("DB_MISSING");
    expect(text).toContain("1.2.3");
    expect(text).toContain("[redacted]");
  });

  it("masks a Windows path in its JSON-escaped form, whatever the case", () => {
    const redact = createRedactor({ platform: "win32", homeDirectory: "C:\\Users\\Me" });
    expect(redact(JSON.stringify({ p: "c:\\USERS\\me\\x" }))).not.toMatch(/users/i);
  });

  it("matches paths literally even when they hold regex metacharacters", () => {
    const redact = createRedactor({ platform: "linux", homeDirectory: "/synthetic/h", paths: ["/a.b/(c)+[d]*"] });
    expect(redact("see /a.b/(c)+[d]* and /aXb/(c)+[d]*")).toBe("see [redacted] and /aXb/(c)+[d]*");
  });
});

describe("last backup", () => {
  const entries: Record<string, { file: boolean; link: boolean }> = {
    "work-automatic-20260101T000000Z.sqlite": { file: true, link: false },
    "work-manual-20260301T120000Z.sqlite": { file: true, link: false },
    "work-manual-20260301T120000Z-2.sqlite": { file: true, link: false },
    "work-automatic-20260401T000000Z.sqlite": { file: true, link: true },
    "work-pre-delete-20260501T000000Z.sqlite": { file: false, link: false },
    "work-automatic-20260601T000000Z.sqlite.bak": { file: true, link: false },
    "other-automatic-20260701T000000Z.sqlite": { file: true, link: false },
    "work-..-20260801T000000Z.sqlite": { file: true, link: false },
  };
  const reader = {
    readdir: async () => Object.keys(entries),
    lstat: async (path: string) => {
      const entry = entries[path.split(/[\\/]/).pop() ?? ""];
      if (!entry) throw new Error("gone");
      return { isFile: () => entry.file, isSymbolicLink: () => entry.link };
    },
  };

  it("takes the newest regular, safely named backup of this database", async () => {
    expect(await readLastBackupFromDirectory("/x/work.sqlite", "/x/backups", reader, "linux")).toEqual({
      status: "known",
      at: "2026-03-01T12:00:00Z",
    });
    expect(await readLastBackupFromDirectory("C:\\x\\work.sqlite", "C:\\x\\backups", reader, "win32")).toEqual({
      status: "known",
      at: "2026-03-01T12:00:00Z",
    });
  });

  it("is none for no matching file or a missing folder, and unknown for an unreadable folder", async () => {
    expect(
      await readLastBackupFromDirectory("/x/work.sqlite", "/x/b", { ...reader, readdir: async () => [] }, "linux"),
    ).toEqual({ status: "none" });
    const failing = (code: string) => ({
      ...reader,
      readdir: async () => {
        throw Object.assign(new Error("x"), { code });
      },
    });
    expect(await readLastBackupFromDirectory("/x/work.sqlite", "/x/b", failing("ENOENT"), "linux")).toEqual({
      status: "none",
    });
    expect(await readLastBackupFromDirectory("/x/work.sqlite", "/x/b", failing("EACCES"), "linux")).toEqual({
      status: "unknown",
    });
  });

  it("joins the folder the way each platform does (trailing slash, mixed slashes, UNC)", async () => {
    const name = "work-automatic-20260101T000000Z.sqlite";
    expect(joinBackupPath("/x/b/", name, "linux")).toBe(`/x/b/${name}`);
    expect(joinBackupPath("/x/b", name, "darwin")).toBe(`/x/b/${name}`);
    expect(joinBackupPath("C:\\x\\b", name, "win32")).toBe(`C:\\x\\b\\${name}`);
    expect(joinBackupPath("C:/x\\b/", name, "win32")).toBe(`C:\\x\\b\\${name}`);
    expect(joinBackupPath("\\\\server\\share\\backups", name, "win32")).toBe(`\\\\server\\share\\backups\\${name}`);
    expect(joinBackupPath("//server/share/backups/", name, "win32")).toBe(`\\\\server\\share\\backups\\${name}`);
  });

  it("scans with the injected platform's joining", async () => {
    const seen: string[] = [];
    const spy = {
      readdir: async () => ["work-automatic-20260101T000000Z.sqlite"],
      lstat: async (path: string) => (seen.push(path), { isFile: () => true, isSymbolicLink: () => false }),
    };
    await readLastBackupFromDirectory("/x/work.sqlite", "/x/b/", spy, "linux");
    await readLastBackupFromDirectory("/x/work.sqlite", "C:/x\\b", spy, "win32");
    expect(seen).toEqual([
      "/x/b/work-automatic-20260101T000000Z.sqlite",
      "C:\\x\\b\\work-automatic-20260101T000000Z.sqlite",
    ]);
  });

  it("prefers the later of the backend's report and the folder, and ignores a bad report", async () => {
    const tracker = new LastBackupTracker(async () => ({ status: "known", at: "2026-03-01T12:00:00Z" }));
    tracker.bindDatabase("A");
    expect(await tracker.current()).toEqual({ status: "known", at: "2026-03-01T12:00:00.000Z" });
    tracker.recordFromBackend("not a date", "A");
    tracker.recordFromBackend("2026-03-02T00:00:00.000Z", "A");
    tracker.recordFromBackend("2026-03-01T00:00:00.000Z", "A");
    expect(await tracker.current()).toEqual({ status: "known", at: "2026-03-02T00:00:00.000Z" });
  });

  it("falls back to the report when the folder cannot be read, and to unknown when neither exists", async () => {
    const unreadable = new LastBackupTracker(async () => {
      throw new Error("x");
    });
    unreadable.bindDatabase("A");
    expect(await unreadable.current()).toEqual({ status: "unknown" });
    unreadable.recordFromBackend("2026-03-02T00:00:00.000Z", "A");
    expect(await unreadable.current()).toEqual({ status: "known", at: "2026-03-02T00:00:00.000Z" });
    expect(await new LastBackupTracker(async () => ({ status: "none" })).current()).toEqual({ status: "none" });
  });

  it("never shows database A's backup for database B", async () => {
    const folders: Record<string, LastBackupInfo> = { A: { status: "none" }, B: { status: "none" } };
    let serving = "A";
    const tracker = new LastBackupTracker(async () => folders[serving] ?? { status: "none" });
    tracker.bindDatabase("A");
    tracker.recordFromBackend("2026-03-02T00:00:00.000Z", "A");
    expect(await tracker.current()).toEqual({ status: "known", at: "2026-03-02T00:00:00.000Z" });

    serving = "B";
    tracker.bindDatabase("B");
    expect(await tracker.current()).toEqual({ status: "none" });

    // A late report from A's child must not count for B; a report from B does.
    tracker.recordFromBackend("2026-03-03T00:00:00.000Z", "A");
    expect(await tracker.current()).toEqual({ status: "none" });
    tracker.recordFromBackend("2026-03-04T00:00:00.000Z", "B");
    expect(await tracker.current()).toEqual({ status: "known", at: "2026-03-04T00:00:00.000Z" });
  });

  it("reads the folder once per TTL, again after a report, a database change or the TTL", async () => {
    let now = 0;
    const scan = vi.fn(async (): Promise<LastBackupInfo> => ({ status: "none" }));
    const tracker = new LastBackupTracker(scan, { clock: () => now, scanTtlMs: 1_000 });
    tracker.bindDatabase("A");
    await tracker.current();
    await tracker.current();
    await tracker.current();
    expect(scan).toHaveBeenCalledTimes(1);
    now = 999;
    await tracker.current();
    expect(scan).toHaveBeenCalledTimes(1);
    now = 1_000;
    await tracker.current();
    expect(scan).toHaveBeenCalledTimes(2);
    tracker.recordFromBackend("2026-03-02T00:00:00.000Z", "A");
    await tracker.current();
    expect(scan).toHaveBeenCalledTimes(3);
    tracker.bindDatabase("B");
    await tracker.current();
    expect(scan).toHaveBeenCalledTimes(4);
    tracker.bindDatabase("B");
    await tracker.current();
    expect(scan).toHaveBeenCalledTimes(4);
  });

  it("shares one scan between concurrent callers and does not cache a scan of the previous database", async () => {
    const resolvers: ((info: LastBackupInfo) => void)[] = [];
    const scan = vi.fn(() => new Promise<LastBackupInfo>((resolve) => resolvers.push(resolve)));
    const tracker = new LastBackupTracker(scan);
    tracker.bindDatabase("A");
    const first = tracker.current();
    const second = tracker.current();
    expect(scan).toHaveBeenCalledTimes(1);
    tracker.bindDatabase("B");
    const third = tracker.current();
    expect(scan).toHaveBeenCalledTimes(2);
    resolvers[0]?.({ status: "known", at: "2026-01-01T00:00:00Z" });
    resolvers[1]?.({ status: "none" });
    expect(await first).toMatchObject({ status: "known" });
    expect(await second).toMatchObject({ status: "known" });
    expect(await third).toEqual({ status: "none" });
    await tracker.current();
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("builds a stable key from the real path and file id, not the lineage", () => {
    const id = { device: "1", inode: "2" };
    expect(databaseKey({ realPath: "/a", fileId: id })).toBe(databaseKey({ realPath: "/a", fileId: { ...id } }));
    expect(databaseKey({ realPath: "/a", fileId: id })).not.toBe(databaseKey({ realPath: "/b", fileId: id }));
    expect(databaseKey({ realPath: "/a", fileId: null })).not.toBe(databaseKey({ realPath: "/a", fileId: id }));
  });
});

describe("RestartPolicy", () => {
  function policy(start = 0) {
    let now = start;
    return { policy: new RestartPolicy({ clock: () => now }), advance: (ms: number) => (now += ms) };
  }

  it("never retries an error a retry cannot fix", () => {
    const { policy: p } = policy();
    for (const code of [
      "DB_MISSING",
      "DB_IDENTITY_CHANGED",
      "SCHEMA_TOO_NEW",
      "SCHEMA_MIGRATION_BLOCKED",
      "RUNTIME_MISSING",
      "RUNTIME_UNSAFE_PERMISSIONS",
      "RUNTIME_ACL_UNREADABLE",
      "RUNTIME_FILE_TAMPERED",
      "PORT_OCCUPIED_BY_OTHER",
      "REPAIR_REQUIRED",
    ]) {
      expect(isDeterministicFailure(code)).toBe(true);
      expect(p.decide(code)).toEqual({ retry: false, reason: "deterministic" });
    }
    expect(isDeterministicFailure("CHILD_EXITED")).toBe(false);
  });

  it("grants three growing retries in a window, then stops", () => {
    const { policy: p, advance } = policy();
    expect(p.decide("CHILD_EXITED")).toEqual({ retry: true, attempt: 1, delayMs: 1_000 });
    advance(1_000);
    expect(p.decide("CHILD_EXITED")).toEqual({ retry: true, attempt: 2, delayMs: 5_000 });
    advance(5_000);
    expect(p.decide("CHILD_START_TIMEOUT")).toEqual({ retry: true, attempt: 3, delayMs: 15_000 });
    expect(p.decide("CHILD_EXITED")).toEqual({ retry: false, reason: "exhausted" });
  });

  it("forgets attempts older than two minutes and starts over on reset", () => {
    const { policy: p, advance } = policy();
    for (let index = 0; index < 3; index += 1) p.decide("CHILD_EXITED");
    expect(p.decide("CHILD_EXITED").retry).toBe(false);
    advance(120_001);
    expect(p.decide("CHILD_EXITED")).toMatchObject({ retry: true, attempt: 1 });
    p.decide("CHILD_EXITED");
    p.decide("CHILD_EXITED");
    expect(p.decide("CHILD_EXITED").retry).toBe(false);
    p.reset();
    expect(p.decide("CHILD_EXITED")).toMatchObject({ retry: true, attempt: 1 });
  });

  it("repeats the last delay and tolerates an empty delay list", () => {
    let now = 0;
    const custom = new RestartPolicy({ clock: () => now, maxAttempts: 4, delaysMs: [10] });
    expect(custom.decide("X")).toMatchObject({ delayMs: 10 });
    now += 1;
    expect(custom.decide("X")).toMatchObject({ delayMs: 10 });
    const none = new RestartPolicy({ clock: () => now, delaysMs: [] });
    expect(none.decide("X")).toMatchObject({ delayMs: 0 });
  });
});

describe("BackendRecovery", () => {
  function setup(outcomes: RestartOutcome[], mode: "interactive" | "background" = "interactive") {
    vi.useFakeTimers();
    const calls: string[] = [];
    const errors = new RecentErrors();
    const presenter = new ErrorPresenter(mode, {
      openRepairWindow: () => calls.push("window"),
      setTrayAttention: (code) => calls.push(`tray:${code}`),
      notify: (code) => calls.push(`notify:${code}`),
    });
    const queue = [...outcomes];
    const deps: BackendRecoveryDeps = {
      policy: new RestartPolicy({ clock: () => Date.now() }),
      presenter,
      errors,
      shouldAutoRetry: () => true,
      restart: async () => {
        calls.push("restart");
        return queue.shift() ?? { ok: true };
      },
      now: () => new Date(),
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
      onOwnerChange: (owner) => calls.push(`owner:${owner}`),
      log: () => undefined,
    };
    return { recovery: new BackendRecovery(deps), calls, errors };
  }

  it("records the code, goes to NEEDS_REPAIR, retries after the delay and recovers", async () => {
    const { recovery, calls, errors } = setup([{ ok: true }]);
    recovery.handleFailure("CHILD_EXITED");
    expect(errors.latest()?.code).toBe("CHILD_EXITED");
    expect(calls).toEqual(["owner:NEEDS_REPAIR"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual(["owner:NEEDS_REPAIR", "restart", "tray:null", "owner:MANAGED"]);
    vi.useRealTimers();
  });

  it("opens the repair window at once for an error a retry cannot fix, and never retries", async () => {
    const { recovery, calls } = setup([]);
    recovery.handleFailure("DB_MISSING");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual(["owner:NEEDS_REPAIR", "tray:DB_MISSING", "window"]);
    vi.useRealTimers();
  });

  it("keeps retrying a failing start up to the budget, then presents the error", async () => {
    const failing: RestartOutcome = { ok: false, code: "CHILD_EXITED" };
    const { recovery, calls } = setup([failing, failing, failing, failing]);
    recovery.handleFailure("CHILD_EXITED");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.filter((call) => call === "restart")).toHaveLength(3);
    expect(calls.at(-2)).toBe("tray:CHILD_EXITED");
    expect(calls.at(-1)).toBe("window");
    vi.useRealTimers();
  });

  it("in background mode shows the error in the tray and notifies once, never a window", async () => {
    const { recovery, calls } = setup([], "background");
    recovery.handleFailure("DB_MISSING");
    recovery.handleFailure("DB_MISSING");
    expect(calls).not.toContain("window");
    expect(calls.filter((call) => call === "notify:DB_MISSING")).toHaveLength(1);
    vi.useRealTimers();
  });

  it("lets the user retry now: it cancels the wait and starts a fresh budget", async () => {
    const { recovery, calls } = setup([{ ok: true }]);
    recovery.handleFailure("CHILD_EXITED");
    expect(await recovery.retryNow()).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.filter((call) => call === "restart")).toHaveLength(1);
    vi.useRealTimers();
  });

  it("presents a failed manual retry and answers busy to a second one that overlaps", async () => {
    const { recovery, calls } = setup([{ ok: false, code: "DB_MISSING" }]);
    const first = recovery.retryNow();
    expect(await recovery.retryNow()).toEqual({ ok: false, busy: true });
    expect(await first).toEqual({ ok: false, code: "DB_MISSING" });
    expect(calls).toContain("window");
    recovery.cancel();
    vi.useRealTimers();
  });
});
