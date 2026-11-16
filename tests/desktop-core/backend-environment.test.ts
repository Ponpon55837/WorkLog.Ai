import { describe, expect, it } from "vitest";
import {
  BackendFailure,
  backendErrorCode,
  buildChildEnvironment,
  LineCollector,
  LineRingBuffer,
  SecretMasker,
} from "../../packages/desktop-core/src/index.js";

// Fictional values only.
const POSIX_PARENT = {
  HOME: "/synthetic/home",
  TMPDIR: "/synthetic/tmp",
  LANG: "en_US.UTF-8",
  LC_ALL: "C",
  LC_CTYPE: "UTF-8",
  TZ: "UTC",
  PATH: "/synthetic/nvm/node/bin:/usr/bin",
  NODE_OPTIONS: "--use-openssl-ca --require /synthetic/hook.js",
  NODE_PATH: "/synthetic/modules",
  ELECTRON_RUN_AS_NODE: "1",
  ELECTRON_NO_ASAR: "1",
  WORK_INTELLIGENCE_DB: "/synthetic/other.sqlite",
  WORK_INTELLIGENCE_PORT: "41999",
  HTTPS_PROXY: "http://synthetic-proxy:3128",
  SSH_AUTH_SOCK: "/synthetic/agent",
  API_TOKEN: "synthetic-secret",
  EMPTY: "",
};

describe("buildChildEnvironment", () => {
  it("copies only the POSIX allowlist, LC_* by prefix, and fixes PATH", () => {
    expect(buildChildEnvironment({ platform: "linux", parentEnvironment: POSIX_PARENT })).toEqual({
      HOME: "/synthetic/home",
      TMPDIR: "/synthetic/tmp",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      LC_CTYPE: "UTF-8",
      TZ: "UTC",
      PATH: "/usr/bin:/bin",
    });
  });

  it("behaves the same on macOS", () => {
    const environment = buildChildEnvironment({ platform: "darwin", parentEnvironment: POSIX_PARENT });
    expect(environment.PATH).toBe("/usr/bin:/bin");
    expect(environment.HOME).toBe("/synthetic/home");
  });

  it("never carries NODE_OPTIONS, NODE_PATH, ELECTRON_*, the user's PATH or inherited WORK_INTELLIGENCE_* values", () => {
    const environment = buildChildEnvironment({ platform: "linux", parentEnvironment: POSIX_PARENT });
    for (const name of [
      "NODE_OPTIONS",
      "NODE_PATH",
      "ELECTRON_RUN_AS_NODE",
      "ELECTRON_NO_ASAR",
      "WORK_INTELLIGENCE_DB",
      "WORK_INTELLIGENCE_PORT",
      "HTTPS_PROXY",
      "SSH_AUTH_SOCK",
      "API_TOKEN",
    ]) {
      expect(environment).not.toHaveProperty(name);
    }
    expect(environment.PATH).not.toContain("nvm");
  });

  it("drops empty and undefined values", () => {
    const environment = buildChildEnvironment({
      platform: "linux",
      parentEnvironment: { HOME: "", TZ: undefined, LANG: "C" },
    });
    expect(environment).toEqual({ LANG: "C", PATH: "/usr/bin:/bin" });
  });

  it("matches Windows names case-insensitively and writes them in their canonical spelling", () => {
    const environment = buildChildEnvironment({
      platform: "win32",
      parentEnvironment: {
        SYSTEMROOT: "D:\\Windows",
        windir: "D:\\Windows",
        temp: "C:\\Users\\Someone\\AppData\\Local\\Temp",
        TMP: "C:\\Users\\Someone\\AppData\\Local\\Temp",
        UserProfile: "C:\\Users\\Someone",
        LOCALAPPDATA: "C:\\Users\\Someone\\AppData\\Local",
        appdata: "C:\\Users\\Someone\\AppData\\Roaming",
        HOMEDRIVE: "C:",
        HOMEPATH: "\\Users\\Someone",
        comspec: "D:\\Windows\\System32\\cmd.exe",
        pathext: ".EXE;.CMD",
        Path: "C:\\Users\\Someone\\node;C:\\Windows",
        NODE_OPTIONS: "--use-openssl-ca",
        node_options: "--inspect",
        Electron_Run_As_Node: "1",
        HOME: "C:\\not-a-windows-variable",
      },
    });

    expect(environment).toEqual({
      SystemRoot: "D:\\Windows",
      windir: "D:\\Windows",
      TEMP: "C:\\Users\\Someone\\AppData\\Local\\Temp",
      TMP: "C:\\Users\\Someone\\AppData\\Local\\Temp",
      USERPROFILE: "C:\\Users\\Someone",
      LOCALAPPDATA: "C:\\Users\\Someone\\AppData\\Local",
      APPDATA: "C:\\Users\\Someone\\AppData\\Roaming",
      HOMEDRIVE: "C:",
      HOMEPATH: "\\Users\\Someone",
      ComSpec: "D:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".EXE;.CMD",
      PATH: "D:\\Windows\\System32",
    });
  });

  it("falls back to C:\\Windows for the Windows PATH when SystemRoot is not set", () => {
    const environment = buildChildEnvironment({ platform: "win32", parentEnvironment: { Path: "C:\\evil" } });
    expect(environment).toEqual({ PATH: "C:\\Windows\\System32" });
  });

  it("adds the App's own WORK_INTELLIGENCE_* values on top", () => {
    const environment = buildChildEnvironment({
      platform: "linux",
      parentEnvironment: POSIX_PARENT,
      desktopValues: { WORK_INTELLIGENCE_BACKUP: "off", WORK_INTELLIGENCE_CONFIG_DIR: "/synthetic/config" },
    });
    expect(environment.WORK_INTELLIGENCE_BACKUP).toBe("off");
    expect(environment.WORK_INTELLIGENCE_CONFIG_DIR).toBe("/synthetic/config");
    expect(environment).not.toHaveProperty("WORK_INTELLIGENCE_DB");
  });

  it.each(["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "PATH", "work_intelligence_db", "WORK_INTELLIGENCE_", "HOME"])(
    "refuses to let the App set %s",
    (name) => {
      expect(() =>
        buildChildEnvironment({ platform: "linux", parentEnvironment: {}, desktopValues: { [name]: "x" } }),
      ).toThrow(RangeError);
    },
  );

  it("does not modify the parent environment", () => {
    const parent = { HOME: "/synthetic/home", NODE_OPTIONS: "--x" };
    buildChildEnvironment({ platform: "linux", parentEnvironment: parent });
    expect(parent).toEqual({ HOME: "/synthetic/home", NODE_OPTIONS: "--x" });
  });
});

describe("LineRingBuffer", () => {
  it("keeps the newest lines in order and overwrites the oldest", () => {
    const buffer = new LineRingBuffer(3);
    expect(buffer.lines()).toEqual([]);
    for (const line of ["a", "b"]) buffer.push(line);
    expect(buffer.lines()).toEqual(["a", "b"]);
    for (const line of ["c", "d", "e"]) buffer.push(line);
    expect(buffer.lines()).toEqual(["c", "d", "e"]);
  });

  it("truncates a long line", () => {
    const buffer = new LineRingBuffer(1, 5);
    buffer.push("abcdefgh");
    expect(buffer.lines()).toEqual(["abcde…"]);
  });

  it.each([0, -1, 1.5])("rejects the capacity %s", (capacity) => {
    expect(() => new LineRingBuffer(capacity)).toThrow(RangeError);
  });
});

function masker(...secrets: string[]): SecretMasker {
  const result = new SecretMasker();
  for (const secret of secrets) result.add(secret);
  return result;
}

describe("LineCollector", () => {
  it("splits chunks into lines on LF and CRLF and holds back a partial line", () => {
    const buffer = new LineRingBuffer(10);
    const collector = new LineCollector(buffer, masker());
    collector.write("one\r\ntw");
    collector.write("o\nthree");
    expect(buffer.lines()).toEqual(["one", "two"]);
    collector.flush();
    collector.flush();
    expect(buffer.lines()).toEqual(["one", "two", "three"]);
  });

  it("masks every known secret, including repeats, and ignores empty and tiny ones", () => {
    const buffer = new LineRingBuffer(10);
    const collector = new LineCollector(buffer, masker("s3cret", "", "/"));
    collector.write("a s3cret and s3cret again /x\n");
    expect(buffer.lines()).toEqual(["a [redacted] and [redacted] again /x"]);
  });

  it("masks a line as a whole before the ring cuts it, so a secret at the cut is never left in half", () => {
    const secret = "S".repeat(40);
    const buffer = new LineRingBuffer(10, 30);
    const collector = new LineCollector(buffer, masker(secret));
    collector.write(`${"x".repeat(20)}${secret}${"y".repeat(20)}\n`);
    expect(buffer.lines()).toEqual([`${"x".repeat(20)}[redacted]${"y".repeat(20)}`.slice(0, 30) + "…"]);
    expect(buffer.lines().join("")).not.toContain("SS");
  });

  it("stores a line that never ends once, masked, and discards the rest of that line", () => {
    const secret = "T".repeat(50);
    const buffer = new LineRingBuffer(10, 20);
    const collector = new LineCollector(buffer, masker(secret));
    collector.write("x".repeat(8190));
    collector.write(`${secret.slice(0, 25)}`);
    collector.write(`${secret.slice(25)} dropped dropped\n`);
    collector.write("after\n");
    expect(buffer.lines()).toEqual([`${"x".repeat(20)}…`, "after"]);
  });
});

describe("SecretMasker", () => {
  it("matches a path literally, never as a pattern", () => {
    const result = masker("/a.b/(c)+[d]*");
    expect(result.apply("see /a.b/(c)+[d]* and /aXb/(c)+[d]*")).toBe("see [redacted] and /aXb/(c)+[d]*");
  });

  it("masks the longest secret first, so a path inside the home is not left half visible", () => {
    const result = masker("/home/u", "/home/u/project/db.sqlite");
    expect(result.apply("/home/u/project/db.sqlite")).toBe("[redacted]");
  });

  it("is case-insensitive and slash-agnostic only when asked (Windows)", () => {
    const windows = new SecretMasker({ caseInsensitive: true });
    windows.add("C:\\Users\\Me");
    expect(windows.apply("c:\\USERS\\me and C:/Users/Me")).toBe("[redacted] and [redacted]");
    expect(masker("C:\\Users\\Me").apply("c:\\users\\me")).toBe("c:\\users\\me");
  });
});

describe("BackendFailure", () => {
  it("carries a code and a detail and prefixes the message with the code", () => {
    const failure = new BackendFailure("DB_MISSING", "the database file is missing");
    expect(failure.message).toBe("DB_MISSING: the database file is missing");
    expect(backendErrorCode(failure)).toBe("DB_MISSING");
  });

  it("falls back for any other error", () => {
    expect(backendErrorCode(new Error("x"))).toBe("REPAIR_REQUIRED");
    expect(backendErrorCode("x", "CHILD_EXITED")).toBe("CHILD_EXITED");
  });
});
