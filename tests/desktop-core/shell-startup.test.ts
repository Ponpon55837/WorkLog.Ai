import { describe, expect, it } from "vitest";
import { resolveUserDataDirectory, shellMessages } from "../../packages/desktop-core/src/shell/index.js";

function access(read: () => string) {
  const writes: string[] = [];
  return { writes, access: { read, write: (path: string) => void writes.push(path) } };
}

describe("resolving the data folder at start-up", () => {
  it("applies a redirect before the first read, so the platform default is never resolved", () => {
    let current: string | undefined;
    const { writes, access: userData } = access(() => {
      if (current === undefined) throw new Error("Failed to get 'userData' path");
      return current;
    });
    userData.write = (path) => {
      writes.push(path);
      current = path;
    };
    expect(resolveUserDataDirectory("/synthetic/data", userData)).toEqual({
      ok: true,
      userDataDirectory: "/synthetic/data",
    });
    expect(writes).toEqual(["/synthetic/data"]);
  });

  it("uses the platform folder when nothing redirects it", () => {
    const { writes, access: userData } = access(() => "C:\\Users\\Someone\\AppData\\Roaming\\Work Intelligence");
    expect(resolveUserDataDirectory(undefined, userData)).toEqual({
      ok: true,
      userDataDirectory: "C:\\Users\\Someone\\AppData\\Roaming\\Work Intelligence",
    });
    expect(writes).toEqual([]);
  });

  it("reports a folder the platform cannot name instead of throwing", () => {
    const { access: userData } = access(() => {
      throw new Error("Failed to get 'userData' path");
    });
    expect(resolveUserDataDirectory(undefined, userData)).toEqual({
      ok: false,
      code: "USER_DATA_UNAVAILABLE",
      detail: "Failed to get 'userData' path",
    });
  });

  it("reports an empty path, a refused redirect and a non-Error throw, each with its own detail", () => {
    expect(resolveUserDataDirectory(undefined, access(() => " ").access)).toMatchObject({
      ok: false,
      detail: "the platform returned an empty path",
    });
    let reads = 0;
    const refusing = access(() => {
      reads += 1;
      return "/unused";
    }).access;
    refusing.write = () => {
      throw new Error("Path must be absolute");
    };
    // A refused redirect is named as such, and the platform default is still never read.
    expect(resolveUserDataDirectory("/synthetic/data", refusing)).toMatchObject({
      ok: false,
      code: "USER_DATA_UNAVAILABLE",
      detail: "the data folder redirect was refused: Path must be absolute",
    });
    expect(reads).toBe(0);
    expect(
      resolveUserDataDirectory(undefined, {
        read: () => {
          throw "not an error";
        },
        write: () => undefined,
      }),
    ).toMatchObject({ ok: false, code: "USER_DATA_UNAVAILABLE", detail: "unknown error" });
  });

  it("has an error box text in both languages", () => {
    for (const locale of ["zh-TW", "en"] as const) {
      const messages = shellMessages(locale);
      expect(messages.startupFailedTitle.length).toBeGreaterThan(0);
      expect(messages.startupFailedMessage.length).toBeGreaterThan(0);
    }
    expect(shellMessages("zh-TW").startupFailedTitle).not.toBe(shellMessages("en").startupFailedTitle);
  });
});
