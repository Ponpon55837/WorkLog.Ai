import { describe, expect, it } from "vitest";
import {
  loginItemMessages,
  loginItemNote,
  loginItemQueryFor,
  readSystemLoginItem,
  repairInputSchemas,
  shouldApplyLoginItemAtStart,
  type RepairLoginItemSection,
} from "../../packages/desktop-core/src/index.js";

const section = (over: Partial<RepairLoginItemSection>): RepairLoginItemSection => ({
  supported: true,
  desired: true,
  system: "enabled",
  ...over,
});

describe("readSystemLoginItem", () => {
  it("reads Windows: the entry turned off in the system's startup settings is disabled", () => {
    expect(readSystemLoginItem("win32", { openAtLogin: true, executableWillLaunchAtLogin: true })).toBe("enabled");
    expect(readSystemLoginItem("win32", { openAtLogin: true, executableWillLaunchAtLogin: false })).toBe("disabled");
    expect(readSystemLoginItem("win32", { openAtLogin: false, executableWillLaunchAtLogin: false })).toBe("disabled");
    expect(readSystemLoginItem("win32", { executableWillLaunchAtLogin: true })).toBe("unknown");
  });

  it("reads macOS by the service status", () => {
    expect(readSystemLoginItem("darwin", { status: "enabled" })).toBe("enabled");
    expect(readSystemLoginItem("darwin", { status: "not-registered" })).toBe("disabled");
    expect(readSystemLoginItem("darwin", { status: "requires-approval" })).toBe("needs-approval");
    expect(readSystemLoginItem("darwin", { status: "not-found" })).toBe("unknown");
  });

  it("never guesses: no answer, a bad answer or another platform is unknown", () => {
    expect(readSystemLoginItem("win32", undefined)).toBe("unknown");
    expect(readSystemLoginItem("darwin", "enabled")).toBe("unknown");
    expect(readSystemLoginItem("linux", { openAtLogin: true })).toBe("unknown");
  });
});

describe("loginItemQueryFor", () => {
  it("asks about the entry the App wrote: the background flag on Windows, the main-app service on macOS", () => {
    expect(loginItemQueryFor("win32")?.args?.length).toBeGreaterThan(0);
    expect(loginItemQueryFor("darwin")).toEqual({ type: "mainAppService" });
    expect(loginItemQueryFor("linux")).toBeUndefined();
  });
});

describe("loginItemNote", () => {
  it("is silent when the choice and the system agree", () => {
    expect(loginItemNote(section({ desired: true, system: "enabled" }))).toBe("none");
    expect(loginItemNote(section({ desired: false, system: "disabled" }))).toBe("none");
    expect(loginItemNote(section({ supported: false, system: "unknown" }))).toBe("none");
  });

  it("explains each way they can differ", () => {
    expect(loginItemNote(section({ desired: true, system: "disabled" }))).toBe("disabled-by-system");
    expect(loginItemNote(section({ desired: true, system: "needs-approval" }))).toBe("needs-approval");
    expect(loginItemNote(section({ desired: false, system: "enabled" }))).toBe("enabled-outside-app");
    expect(loginItemNote(section({ desired: true, system: "unknown" }))).toBe("unknown");
  });
});

describe("login item text", () => {
  it.each(["zh-TW", "en"] as const)("has no command in %s", (locale) => {
    const text = loginItemMessages(locale);
    const all = [
      text.heading,
      text.label,
      text.intro,
      text.statusOn,
      text.statusOff,
      text.statusUnknown,
      text.unsupported,
      text.failed,
      ...Object.values(text.notes),
    ];
    for (const line of all) {
      expect(line.length).toBeGreaterThan(0);
      expect(line).not.toMatch(/\bpnpm\b|\bnpm\b|\bnode\b|\bsudo\b|\bschtasks\b|\blaunchctl\b|\bsystemctl\b|`|\$ /i);
    }
  });
});

describe("the login item request", () => {
  it("takes one boolean and nothing else", () => {
    const schema = repairInputSchemas.loginItemSet;
    expect(schema.safeParse({ enable: true }).success).toBe(true);
    expect(schema.safeParse({ enable: false }).success).toBe(true);
    expect(schema.safeParse({ enable: "true" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ enable: true, consent: true }).success).toBe(false);
    expect(schema.safeParse({ enable: true, path: "/x" }).success).toBe(false);
  });
});

describe("shouldApplyLoginItemAtStart", () => {
  it("leaves a registered entry alone, even one the user switched off in the system", () => {
    expect(shouldApplyLoginItemAtStart("win32", { openAtLogin: true, executableWillLaunchAtLogin: false }, true)).toBe(
      false,
    );
    expect(shouldApplyLoginItemAtStart("win32", { openAtLogin: true, executableWillLaunchAtLogin: true }, true)).toBe(
      false,
    );
    expect(shouldApplyLoginItemAtStart("darwin", { status: "requires-approval" }, true)).toBe(false);
  });

  it("writes a missing entry the user wants and removes one the user does not want", () => {
    expect(shouldApplyLoginItemAtStart("win32", { openAtLogin: false }, true)).toBe(true);
    expect(shouldApplyLoginItemAtStart("darwin", { status: "not-registered" }, true)).toBe(true);
    expect(shouldApplyLoginItemAtStart("win32", { openAtLogin: true }, false)).toBe(true);
    expect(shouldApplyLoginItemAtStart("win32", { openAtLogin: false }, false)).toBe(false);
  });

  it("applies when the answer cannot be read", () => {
    expect(shouldApplyLoginItemAtStart("win32", undefined, true)).toBe(true);
    expect(shouldApplyLoginItemAtStart("darwin", { status: "not-found" }, false)).toBe(true);
  });
});
