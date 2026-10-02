import { describe, expect, it } from "vitest";
import {
  commitUrl,
  editorFileUrl,
  editorProtocolLabels,
  pathInsideProject,
} from "../../../apps/web/src/utils/code-links.js";
import { locale, t } from "../../../apps/web/src/i18n/index.js";

describe("pathInsideProject", () => {
  it("joins project-relative and absolute paths under the root", () => {
    expect(pathInsideProject("/work/apiary", "src/hive.ts")).toBe("/work/apiary/src/hive.ts");
    expect(pathInsideProject("/work/apiary/", "./src//hive.ts")).toBe("/work/apiary/src/hive.ts");
    expect(pathInsideProject("/work/apiary", "/work/apiary/src/hive.ts")).toBe("/work/apiary/src/hive.ts");
    expect(pathInsideProject("C:\\work\\apiary", "src\\hive.ts")).toBe("C:/work/apiary/src/hive.ts");
    expect(pathInsideProject("C:\\work\\apiary", "c:/work/apiary/src/hive.ts")).toBe("C:/work/apiary/src/hive.ts");
  });

  it("never leaves the project root", () => {
    expect(pathInsideProject("/work/apiary", "../orchard/secret.ts")).toBeUndefined();
    expect(pathInsideProject("/work/apiary", "src/../../orchard.ts")).toBeUndefined();
    expect(pathInsideProject("/work/apiary", "/etc/passwd")).toBeUndefined();
    expect(pathInsideProject("/work/apiary", "/work/apiary-other/file.ts")).toBeUndefined();
    expect(pathInsideProject("/work/apiary", "C:/other/file.ts")).toBeUndefined();
    expect(pathInsideProject("/work/apiary", "")).toBeUndefined();
    expect(pathInsideProject("/work/apiary", ".")).toBeUndefined();
    expect(pathInsideProject("/work/apiary", "src/\0evil.ts")).toBeUndefined();
    expect(pathInsideProject("", "src/hive.ts")).toBeUndefined();
  });
});

describe("editorFileUrl", () => {
  it("builds vscode:// and cursor:// links with encoded segments", () => {
    expect(editorFileUrl("vscode", "/work/apiary", "src/hive frame#1.ts")).toBe(
      "vscode://file/work/apiary/src/hive%20frame%231.ts",
    );
    expect(editorFileUrl("cursor", "C:\\work\\apiary", "src\\hive.ts")).toBe(
      "cursor://file/C:/work/apiary/src/hive.ts",
    );
  });

  it("gives no link without an editor or for a path outside the project", () => {
    expect(editorFileUrl("none", "/work/apiary", "src/hive.ts")).toBeUndefined();
    expect(editorFileUrl("vscode", "/work/apiary", "../escape.ts")).toBeUndefined();
  });
});

describe("commitUrl", () => {
  it("links to the commit on the repository host", () => {
    expect(commitUrl("https://github.com/owner/repo", "ABCDEF1234567")).toBe(
      "https://github.com/owner/repo/commit/abcdef1234567",
    );
    expect(commitUrl("https://gitlab.com/group/repo.git/", "abcdef1")).toBe(
      "https://gitlab.com/group/repo/commit/abcdef1",
    );
    expect(commitUrl("https://bitbucket.org/team/repo", "abcdef1")).toBe(
      "https://bitbucket.org/team/repo/commits/abcdef1",
    );
  });

  it("refuses unsafe URLs and anything that is not a commit SHA", () => {
    expect(commitUrl("http://github.com/owner/repo", "abcdef1")).toBeUndefined();
    expect(commitUrl("javascript:alert(1)", "abcdef1")).toBeUndefined();
    expect(commitUrl("https://user:secret@github.com/owner/repo", "abcdef1")).toBeUndefined();
    expect(commitUrl("https://github.com/owner/repo", "main")).toBeUndefined();
    expect(commitUrl("https://github.com/owner/repo", "abc/../../x")).toBeUndefined();
    expect(commitUrl(undefined, "abcdef1")).toBeUndefined();
    expect(commitUrl("https://github.com/owner/repo", undefined)).toBeUndefined();
  });
});

describe("editorProtocolLabels", () => {
  it("translates the no-editor choice and keeps product names as they are", () => {
    expect(editorProtocolLabels.none).toBe(t("labels.none"));
    locale.value = "en-US";
    expect(editorProtocolLabels.none).toBe(t("labels.none"));
    expect(editorProtocolLabels.vscode).toBe("VS Code");
    expect(editorProtocolLabels.cursor).toBe("Cursor");
    locale.value = "zh-TW";
  });
});
