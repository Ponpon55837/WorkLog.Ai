import { describe, expect, it } from "vitest";
import {
  buildSetupState,
  canonicalDatabasePath,
  canCreateNewDatabase,
  decideLegacyStart,
  legacyServiceConflicts,
  legacyServiceWarns,
  legacyServiceRelevance,
  type SetupSourceInput,
  type SetupStateInputs,
} from "../../packages/desktop-core/src/shell/index.js";
import type { DbSourceDecision, DbSourceGroup } from "../../packages/desktop-core/src/db-source/types.js";
import type {
  LegacyServiceDetection,
  LegacyServiceFound,
} from "../../packages/desktop-core/src/legacy-service/types.js";

const HOME = "/home/tester";
const DB_PATH = "/home/tester/.work-intelligence/data.db";
const OTHER_DB_PATH = "/home/tester/other/data.db";

function group(id: string, absolutePath: string): DbSourceGroup {
  return {
    id,
    candidates: [],
    kinds: ["standalone-default"],
    status: "ok",
    probeStatus: "ok",
    identity: null,
    preview: { projectCount: 3 },
    absolutePath,
  };
}

function source(id: string, absolutePath: string, canUse = true): SetupSourceInput {
  return { id, group: group(`group-${id}`, absolutePath), projectNames: ["Alpha"], canUse, needsMigration: false };
}

function found(overrides: Partial<LegacyServiceFound> = {}): LegacyServiceFound {
  return {
    kind: "found",
    platform: "linux",
    definitionPath: "/home/tester/.config/systemd/user/work-intelligence.service",
    definitionSource: "file",
    recognised: true,
    databasePath: DB_PATH,
    port: 4317,
    running: "running",
    ...overrides,
  };
}

function inputs(overrides: Partial<SetupStateInputs> = {}): SetupStateInputs {
  return {
    locale: "en",
    platform: "linux",
    homeDirectory: HOME,
    phase: "ready",
    decision: null,
    sources: [],
    defaults: { databasePath: DB_PATH, port: 4317, backupDirectory: "/home/tester/backups", launchAtLogin: true },
    legacy: null,
    busy: false,
    ...overrides,
  };
}

describe("buildSetupState screens", () => {
  it("shows the new screen when nothing was found", () => {
    const state = buildSetupState(inputs());
    expect(state.screen).toBe("new");
    expect(state.reason).toBeUndefined();
    expect(state.recommendedId).toBeUndefined();
  });

  it("shows the new screen when a new database is offered", () => {
    const decision: DbSourceDecision = { kind: "offer-new-database", path: DB_PATH, requiresExplicitConsent: true };
    expect(buildSetupState(inputs({ decision })).screen).toBe("new");
  });

  it("recommends the one usable database on the existing screen", () => {
    const decision: DbSourceDecision = { kind: "use", group: group("group-a", DB_PATH), reason: "default" };
    const state = buildSetupState(inputs({ decision, sources: [source("a", DB_PATH)] }));
    expect(state.screen).toBe("existing");
    expect(state.recommendedId).toBe("a");
    expect(state.reason).toBeUndefined();
  });

  it("asks the user to choose when the single database cannot be used", () => {
    const decision: DbSourceDecision = { kind: "use", group: group("group-a", DB_PATH), reason: "default" };
    const state = buildSetupState(inputs({ decision, sources: [source("a", DB_PATH, false)] }));
    expect(state).toMatchObject({ screen: "choose", reason: "unverifiable" });
    expect(state.recommendedId).toBeUndefined();
  });

  it("asks the user to choose when the decision's database has no source entry", () => {
    const decision: DbSourceDecision = { kind: "use", group: group("group-missing", DB_PATH), reason: "default" };
    expect(buildSetupState(inputs({ decision })).reason).toBe("unverifiable");
  });

  it("passes the reason of a needs-user-choice decision through", () => {
    for (const reason of ["multiple-distinct", "conflict", "unverifiable"] as const) {
      const decision: DbSourceDecision = { kind: "needs-user-choice", groups: [], reason };
      expect(buildSetupState(inputs({ decision }))).toMatchObject({ screen: "choose", reason });
    }
  });

  it("shows the blocked reason when the selected source is unavailable", () => {
    const decision: DbSourceDecision = {
      kind: "blocked",
      reason: "selected-source-unavailable",
      status: "missing",
      group: group("group-a", DB_PATH),
      source: "explicit-selection",
    };
    expect(buildSetupState(inputs({ decision }))).toMatchObject({ screen: "choose", reason: "blocked" });
  });

  it("forces the choose screen when the user browsed to a database of their own", () => {
    const decision: DbSourceDecision = { kind: "use", group: group("group-a", DB_PATH), reason: "default" };
    const state = buildSetupState(inputs({ chosen: true, decision, sources: [source("a", DB_PATH)] }));
    expect(state).toMatchObject({ screen: "choose", reason: "multiple-distinct" });
    expect(state.recommendedId).toBeUndefined();
    expect(buildSetupState(inputs({ chosen: true })).screen).toBe("choose");
  });

  it.each([
    ["new", undefined],
    ["existing", { kind: "use", group: group("group-a", DB_PATH), reason: "default" } as DbSourceDecision],
    ["choose", { kind: "needs-user-choice", groups: [], reason: "conflict" } as DbSourceDecision],
  ])("always carries the defaults on the %s screen", (screen, decision) => {
    const state = buildSetupState(inputs({ decision: decision ?? null, sources: [source("a", DB_PATH)] }));
    expect(state.screen).toBe(screen);
    expect(state.defaults).toEqual({
      databaseDisplay: "~/.work-intelligence/data.db",
      url: "http://127.0.0.1:4317",
      backupDisplay: "~/backups",
      launchAtLogin: true,
      legacyConflict: false,
    });
  });
});

describe("buildSetupState content", () => {
  it("masks paths, maps sources and flags the legacy conflict per database", () => {
    const state = buildSetupState(
      inputs({
        sources: [source("a", DB_PATH), source("b", OTHER_DB_PATH)],
        legacy: found(),
        errorCode: "DB_MISSING",
        busy: true,
      }),
    );
    expect(state.sources.map((entry) => [entry.id, entry.display, entry.legacyConflict, entry.projectCount])).toEqual([
      ["a", "~/.work-intelligence/data.db", true, 3],
      ["b", "~/other/data.db", false, 3],
    ]);
    expect(state.defaults.legacyConflict).toBe(true);
    expect(state.legacy).toEqual({
      running: "running",
      startsAtLogin: false,
      recognised: true,
      // The fixture carries no definition digest, so the App does not offer to disable it.
      canDisable: false,
      databaseDisplay: "~/.work-intelligence/data.db",
    });
    expect(state.errorCode).toBe("DB_MISSING");
    expect(state.busy).toBe(true);
  });

  it("has no legacy view without a found service", () => {
    expect(buildSetupState(inputs()).legacy).toBeNull();
    expect(buildSetupState(inputs({ legacy: { kind: "none" } })).legacy).toBeNull();
  });
});

describe("legacyServiceConflicts", () => {
  it("conflicts when the service serves the same database", () => {
    expect(legacyServiceConflicts(found(), DB_PATH, "linux")).toBe(true);
    expect(legacyServiceConflicts(found({ running: "unknown" }), DB_PATH, "linux")).toBe(true);
  });

  it("does not conflict without a service, with a stopped one, or with another database", () => {
    expect(legacyServiceConflicts(null, DB_PATH, "linux")).toBe(false);
    expect(legacyServiceConflicts({ kind: "none" }, DB_PATH, "linux")).toBe(false);
    expect(legacyServiceConflicts(found({ running: "stopped" }), DB_PATH, "linux")).toBe(false);
    expect(legacyServiceConflicts(found(), OTHER_DB_PATH, "linux")).toBe(false);
  });

  it("counts an unrecognised definition or an unknown database as a conflict", () => {
    expect(legacyServiceConflicts(found({ recognised: false }), OTHER_DB_PATH, "linux")).toBe(true);
    expect(legacyServiceConflicts(found({ databasePath: undefined }), OTHER_DB_PATH, "linux")).toBe(true);
  });

  it("ignores trailing slashes and compares Windows paths case-insensitively", () => {
    const winDetection = found({ platform: "win32", databasePath: "C:\\Users\\tester\\Data\\wi.db" });
    expect(legacyServiceConflicts(winDetection, "c:/users/TESTER/data/WI.db", "win32")).toBe(true);
    expect(legacyServiceConflicts(found({ databasePath: "/home/tester/Data/" }), "/home/tester/Data", "linux")).toBe(
      true,
    );
    expect(legacyServiceConflicts(found({ databasePath: "/home/tester/Data" }), "/home/tester/data", "linux")).toBe(
      false,
    );
  });
});

describe("legacyServiceRelevance", () => {
  const base = {
    detection: found() as LegacyServiceDetection | null,
    databasePath: DB_PATH as string | null,
    port: 4317 as number | null,
    latestErrorCode: "PORT_OCCUPIED_BY_OTHER" as string | undefined,
    platform: "linux" as NodeJS.Platform,
  };

  it("reports both flags for a running service on the same database and port", () => {
    expect(legacyServiceRelevance(base)).toEqual({ conflict: true, portInUse: true });
  });

  it("reports nothing without a found service", () => {
    expect(legacyServiceRelevance({ ...base, detection: null })).toEqual({ conflict: false, portInUse: false });
    expect(legacyServiceRelevance({ ...base, detection: { kind: "none" } })).toEqual({
      conflict: false,
      portInUse: false,
    });
  });

  it("has no conflict without a database path", () => {
    expect(legacyServiceRelevance({ ...base, databasePath: null })).toEqual({ conflict: false, portInUse: true });
  });

  it("flags the port only after PORT_OCCUPIED_BY_OTHER", () => {
    expect(legacyServiceRelevance({ ...base, latestErrorCode: "DB_MISSING" }).portInUse).toBe(false);
    expect(legacyServiceRelevance({ ...base, latestErrorCode: undefined }).portInUse).toBe(false);
  });

  it("does not flag the port of a stopped service", () => {
    expect(legacyServiceRelevance({ ...base, detection: found({ running: "stopped" }) })).toEqual({
      conflict: false,
      portInUse: false,
    });
  });

  it("flags the port when the service port is unknown but not when it differs", () => {
    expect(legacyServiceRelevance({ ...base, detection: found({ port: undefined }) }).portInUse).toBe(true);
    expect(legacyServiceRelevance({ ...base, detection: found({ port: 5000 }) }).portInUse).toBe(false);
    expect(legacyServiceRelevance({ ...base, port: null }).portInUse).toBe(false);
  });

  it("compares Windows database paths case-insensitively", () => {
    const detection = found({ platform: "win32", databasePath: "C:\\Users\\tester\\Data\\wi.db" });
    const relevance = (platform: NodeJS.Platform) =>
      legacyServiceRelevance({ ...base, detection, databasePath: "c:\\users\\TESTER\\data\\WI.db", platform });
    expect(relevance("win32").conflict).toBe(true);
    expect(relevance("linux").conflict).toBe(false);
  });
});

describe("the default action while the detection runs", () => {
  it("is not available while detecting, and is once the detection is done", () => {
    expect(buildSetupState(inputs({ phase: "detecting" })).canUseDefaults).toBe(false);
    expect(buildSetupState(inputs({ phase: "ready" })).canUseDefaults).toBe(true);
  });

  it("allows a new database only when the detection is done", () => {
    expect(canCreateNewDatabase("detecting")).toBe(false);
    expect(canCreateNewDatabase("starting")).toBe(false);
    expect(canCreateNewDatabase("done")).toBe(false);
    expect(canCreateNewDatabase("ready")).toBe(true);
  });

  it("shows the recommended source in the same state that enables the default action", () => {
    const decision: DbSourceDecision = { kind: "use", group: group("group-a", DB_PATH), reason: "default" };
    const state = buildSetupState(inputs({ decision, sources: [source("a", DB_PATH)] }));
    expect(state).toMatchObject({ screen: "existing", recommendedId: "a", canUseDefaults: true });
  });
});

describe("canonicalDatabasePath", () => {
  const links: Record<string, string> = {
    "/var/data": "/private/var/data",
    "/var/data/wi.db": "/private/var/data/wi.db",
    "/var/data/new": "/private/var/data/new",
    "C:\\Users\\TESTER~1\\wi.db": "C:\\Users\\Tester One\\wi.db",
    "C:\\Users\\TESTER~1": "C:\\Users\\Tester One",
    "C:\\Users\\Tester One\\wi.db": "\\\\?\\C:\\Users\\Tester One\\wi.db",
  };
  const realpath = (value: string): string => {
    const target = links[value];
    if (target === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return target;
  };

  it("resolves symlinks and Windows short names, and strips the extended-length prefix", () => {
    expect(canonicalDatabasePath("/var/data/wi.db", "linux", realpath)).toBe("/private/var/data/wi.db");
    expect(canonicalDatabasePath("C:\\Users\\TESTER~1\\wi.db", "win32", realpath)).toBe("c:\\users\\tester one\\wi.db");
  });

  it("compares a database that does not exist yet by its resolved folder", () => {
    expect(canonicalDatabasePath("/var/data/fresh.db", "linux", realpath)).toBe("/private/var/data/fresh.db");
    expect(canonicalDatabasePath("/nowhere/fresh.db", "linux", realpath)).toBe("/nowhere/fresh.db");
  });

  it("folds case on Windows and macOS, not on Linux", () => {
    expect(canonicalDatabasePath("/Users/T/Data.DB", "darwin", realpath)).toBe("/users/t/data.db");
    expect(canonicalDatabasePath("D:/Data/WI.db/", "win32", realpath)).toBe("d:\\data\\wi.db");
    expect(canonicalDatabasePath("/Users/T/Data.DB", "linux", realpath)).toBe("/Users/T/Data.DB");
  });

  it("makes a symlinked database path conflict with the real one, through the conflict checks", () => {
    const detection = found({ databasePath: "/private/var/data/wi.db" });
    expect(legacyServiceConflicts(detection, "/var/data/wi.db", "linux", realpath)).toBe(true);
    expect(legacyServiceConflicts(detection, "/var/data/wi.db", "linux", (value) => value)).toBe(false);
    expect(legacyServiceWarns(detection, "/var/data/wi.db", "linux", realpath)).toBe(true);
  });

  it("treats a macOS path that differs only in case as the same database", () => {
    const detection = found({ platform: "darwin", databasePath: "/Users/Tester/Data/wi.db" });
    expect(legacyServiceConflicts(detection, "/users/tester/data/WI.db", "darwin", realpath)).toBe(true);
  });
});

describe("legacyServiceWarns", () => {
  it("warns for a running service and for a stopped one that starts at login", () => {
    expect(legacyServiceWarns(found({ running: "running" }), DB_PATH, "linux")).toBe(true);
    expect(legacyServiceWarns(found({ running: "unknown" }), DB_PATH, "linux")).toBe(true);
    expect(legacyServiceWarns(found({ running: "stopped", enabled: "enabled" }), DB_PATH, "linux")).toBe(true);
  });

  it("does not warn for a stopped service that is disabled or whose autostart is unknown", () => {
    expect(legacyServiceWarns(found({ running: "stopped", enabled: "disabled" }), DB_PATH, "linux")).toBe(false);
    expect(legacyServiceWarns(found({ running: "stopped", enabled: "unknown" }), DB_PATH, "linux")).toBe(false);
    expect(legacyServiceWarns(found({ running: "stopped" }), DB_PATH, "linux")).toBe(false);
  });

  it("does not warn without a service or for another database", () => {
    expect(legacyServiceWarns(null, DB_PATH, "linux")).toBe(false);
    expect(legacyServiceWarns({ kind: "none" }, DB_PATH, "linux")).toBe(false);
    expect(legacyServiceWarns(found({ running: "stopped", enabled: "enabled" }), OTHER_DB_PATH, "linux")).toBe(false);
  });

  it("never blocks a stopped service, enabled or not", () => {
    expect(legacyServiceConflicts(found({ running: "stopped", enabled: "enabled" }), DB_PATH, "linux")).toBe(false);
  });

  it("shows the warning in the status views and the first-run page for a stopped, enabled service", () => {
    const stopped = found({ running: "stopped", enabled: "enabled" });
    expect(
      legacyServiceRelevance({
        detection: stopped,
        databasePath: DB_PATH,
        port: 4317,
        latestErrorCode: undefined,
        platform: "linux",
      }),
    ).toEqual({ conflict: true, portInUse: false });
    const state = buildSetupState(inputs({ legacy: stopped, sources: [source("a", DB_PATH)] }));
    expect(state.defaults.legacyConflict).toBe(true);
    expect(state.legacy).toMatchObject({ running: "stopped", startsAtLogin: true });
    const disabled = buildSetupState(inputs({ legacy: found({ running: "stopped", enabled: "disabled" }) }));
    expect(disabled.defaults.legacyConflict).toBe(false);
    expect(disabled.legacy?.startsAtLogin).toBe(false);
  });
});

describe("decideLegacyStart", () => {
  const decide = (
    detection: LegacyServiceDetection | null,
    launchMode: "interactive" | "background",
    extra: { allowed?: boolean; databasePath?: string } = {},
  ) =>
    decideLegacyStart({
      detection,
      databasePath: extra.databasePath ?? DB_PATH,
      platform: "linux",
      launchMode,
      allowed: extra.allowed ?? false,
    });
  const enabledStopped = found({ running: "stopped", enabled: "enabled" });

  it("holds a login start back when the old service is enabled but not running yet", () => {
    expect(decide(enabledStopped, "background")).toBe("hold-login");
  });

  it("starts an interactive start with the warning when the service is enabled but not running", () => {
    expect(decide(enabledStopped, "interactive")).toBe("start");
  });

  it("starts normally when the service is not installed, stale (nothing found), disabled or on another database", () => {
    for (const mode of ["background", "interactive"] as const) {
      expect(decide({ kind: "none" }, mode)).toBe("start");
      expect(decide(null, mode)).toBe("start");
      expect(decide(found({ running: "stopped", enabled: "disabled" }), mode)).toBe("start");
      expect(decide(found({ running: "stopped", enabled: "unknown" }), mode)).toBe("start");
      expect(decide(enabledStopped, mode, { databasePath: OTHER_DB_PATH })).toBe("start");
    }
  });

  it("keeps holding a start back while the old backend may answer, in either mode", () => {
    for (const mode of ["background", "interactive"] as const) {
      expect(decide(found({ running: "running" }), mode)).toBe("hold-active");
      expect(decide(found({ running: "unknown" }), mode)).toBe("hold-active");
    }
  });

  it("starts once the user said 仍要啟動 for this database", () => {
    expect(decide(enabledStopped, "background", { allowed: true })).toBe("start");
    expect(decide(found({ running: "running" }), "interactive", { allowed: true })).toBe("start");
  });
});
