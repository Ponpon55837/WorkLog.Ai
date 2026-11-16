import { describe, expect, it } from "vitest";
import { assessSqliteWalResetFix, parseSqliteVersion } from "../../packages/shared/src/sqlite-version.js";

describe("parseSqliteVersion", () => {
  it("parses major.minor.patch and ignores whitespace and a fourth component", () => {
    expect(parseSqliteVersion("3.51.3")).toEqual({ major: 3, minor: 51, patch: 3 });
    expect(parseSqliteVersion(" 3.45.1.1\n")).toEqual({ major: 3, minor: 45, patch: 1 });
  });

  it.each(["", "3", "3.51", "v3.51.3", "3.51.x", "3.51.3-beta", "a.b.c", "3..3", "-3.1.1", "99999999999999999999.0.0"])(
    "rejects %j",
    (value) => {
      expect(parseSqliteVersion(value)).toBeNull();
    },
  );
});

describe("assessSqliteWalResetFix", () => {
  it.each(["3.51.3", "3.51.4", "3.52.0", "3.53.4", "4.0.0", "3.50.7", "3.50.8", "3.44.6", "3.44.7"])(
    "treats %s as patched",
    (version) => {
      expect(assessSqliteWalResetFix(version)).toEqual({ version, affected: false, recognized: true });
    },
  );

  it.each([
    ["3.51.2", "3.51.3"],
    ["3.51.0", "3.51.3"],
    ["3.50.6", "3.50.7"],
    ["3.50.0", "3.50.7"],
    ["3.49.2", "3.50.7"],
    ["3.45.0", "3.50.7"],
    ["3.46.1", "3.50.7"],
    ["3.44.5", "3.44.6"],
    ["3.44.0", "3.44.6"],
    ["3.43.2", "3.44.6"],
    ["3.7.0", "3.44.6"],
  ])("treats %s as affected and points to %s", (version, fixedIn) => {
    expect(assessSqliteWalResetFix(version)).toEqual({ version, affected: true, fixedIn, recognized: true });
  });

  it("treats versions before WAL (3.7.0) as affected", () => {
    expect(assessSqliteWalResetFix("3.6.23")).toMatchObject({ affected: true, recognized: true });
  });

  it("normalizes a fourth component and surrounding whitespace", () => {
    expect(assessSqliteWalResetFix(" 3.50.7.1 ")).toEqual({ version: "3.50.7", affected: false, recognized: true });
  });

  it.each(["", "unknown", "3.51", "v3.51.3", "3.51.3-rc1"])("fails safe for malformed %j", (value) => {
    expect(assessSqliteWalResetFix(value)).toEqual({ version: value.trim(), affected: true, recognized: false });
  });
});
