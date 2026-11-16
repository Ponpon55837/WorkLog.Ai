import process from "node:process";
import { describe, expect, it } from "vitest";
import {
  builtinUsersWriteArguments,
  parseWhoamiSid,
  privateDirectoryAclArguments,
  securePrivateDirectory,
} from "../../scripts/desktop-runtime-spike/secure-directory.mjs";

const USER_SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";

describe("test directory ACL helper", () => {
  it("reads the SID from whoami's CSV output", () => {
    expect(parseWhoamiSid(`"synthetic-host\\synthetic user","${USER_SID}"\r\n`)).toBe(USER_SID);
  });

  it("refuses output without a SID", () => {
    expect(() => parseWhoamiSid("ERROR: nothing")).toThrow(/no SID/);
  });

  it("removes inheritance and grants full inheritable control to the user, SYSTEM and Administrators only", () => {
    const directory = "D:\\a\\_temp\\啟動器 spike";
    expect(privateDirectoryAclArguments(directory, USER_SID)).toEqual([
      directory,
      "/inheritance:r",
      "/grant:r",
      `*${USER_SID}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
    ]);
  });

  it("grants BUILTIN\\Users modify for the negative case", () => {
    expect(builtinUsersWriteArguments("C:\\x y")).toEqual(["C:\\x y", "/grant", "*S-1-5-32-545:(OI)(CI)M"]);
  });

  it.skipIf(process.platform === "win32")("does nothing outside Windows", () => {
    expect(securePrivateDirectory("/nonexistent/directory")).toBe("/nonexistent/directory");
  });
});
