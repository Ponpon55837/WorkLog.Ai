import { describe, expect, it } from "vitest";
import {
  buildRepairState,
  buildTrayMenu,
  evaluateReleases,
  GITHUB_API_ORIGIN,
  installerAssetFor,
  isNewerThanRunning,
  isOurReleaseUrl,
  NOTES_MAX_CHARACTERS,
  parseReleaseTag,
  parseRunningVersion,
  RELEASE_REPO_SLUG,
  releaseAssetUrl,
  releasesApiUrl,
  releasesPageUrl,
  releaseTagUrl,
  repairInputSchemas,
  sanitizeNotes,
  shellMessages,
  updateCheckResultSchema,
  updateMessages,
  type ReleaseList,
} from "../../packages/desktop-core/src/index.js";

const SLUG = "Ponpon55837/WorkLog.Ai";
const BASE = `https://github.com/${SLUG}/releases`;

interface FakeRelease {
  tag: string;
  draft?: boolean;
  prerelease?: boolean;
  body?: string | null;
  html_url?: string;
  assets?: { name: string; browser_download_url: string }[];
  published_at?: string | null;
}

function installers(tag: string): { name: string; browser_download_url: string }[] {
  const version = tag.slice(1);
  return [
    `Work-Intelligence-${version}-win-x64-setup.exe`,
    `Work-Intelligence-${version}-mac-arm64.dmg`,
    `Work-Intelligence-${version}-mac-x64.dmg`,
    "SHA256SUMS.txt",
  ].map((name) => ({ name, browser_download_url: `${BASE}/download/${tag}/${name}` }));
}

function release(fake: FakeRelease): ReleaseList[number] {
  return {
    tag_name: fake.tag,
    draft: fake.draft ?? false,
    prerelease: fake.prerelease ?? false,
    published_at: fake.published_at === undefined ? "2030-01-02T03:04:05Z" : fake.published_at,
    body: fake.body === undefined ? "Synthetic notes" : fake.body,
    html_url: fake.html_url ?? `${BASE}/tag/${fake.tag}`,
    assets: fake.assets ?? installers(fake.tag),
  };
}

function evaluate(
  fakes: FakeRelease[],
  currentVersion = "1.6.52",
  platform = "win32",
  arch = "x64",
): ReturnType<typeof evaluateReleases> {
  return evaluateReleases(fakes.map(release), { currentVersion, platform, arch });
}

describe("the repository constant", () => {
  it("derives the endpoint, the link validation and the fallback link", () => {
    expect(RELEASE_REPO_SLUG).toBe(SLUG);
    expect(releasesApiUrl()).toBe(`https://api.github.com/repos/${SLUG}/releases?per_page=20`);
    expect(releasesPageUrl()).toBe(`https://github.com/${SLUG}/releases`);
    expect(GITHUB_API_ORIGIN).toBe("https://api.github.com");
    const other = "synthetic-owner/synthetic-repo";
    expect(releasesApiUrl(other)).toBe(`https://api.github.com/repos/${other}/releases?per_page=20`);
    expect(releasesApiUrl(other, "http://127.0.0.1:9")).toBe(`http://127.0.0.1:9/repos/${other}/releases?per_page=20`);
    expect(releasesPageUrl(other)).toBe(`https://github.com/${other}/releases`);
    expect(releaseTagUrl("v1.2.3", other)).toBe(`https://github.com/${other}/releases/tag/v1.2.3`);
    const asset = releaseAssetUrl("v1.2.3", "Work-Intelligence-1.2.3-mac-x64.dmg", other);
    expect(asset).toBe(`https://github.com/${other}/releases/download/v1.2.3/Work-Intelligence-1.2.3-mac-x64.dmg`);
    // The validation follows the slug it is given, and refuses the other repository's links.
    expect(isOurReleaseUrl(asset, other)).toBe(true);
    expect(isOurReleaseUrl(asset)).toBe(false);
    expect(isOurReleaseUrl(releasesPageUrl(other), other)).toBe(true);
    expect(isOurReleaseUrl(releaseTagUrl("v1.2.3", other))).toBe(false);
    // The default validation is the default slug.
    expect(isOurReleaseUrl(releasesPageUrl())).toBe(true);
    expect(isOurReleaseUrl(releaseTagUrl("v1.2.3"))).toBe(true);
  });
});

describe("release tags and versions", () => {
  it("accepts exactly vMAJOR.MINOR.PATCH", () => {
    expect(parseReleaseTag("v1.6.53")).toEqual({ tag: "v1.6.53", version: "1.6.53", major: 1, minor: 6, patch: 53 });
    for (const tag of [
      "1.6.53",
      "v1.6",
      "v1.6.53-rc.1",
      "v1.6.53+build",
      "v1.6.53.1",
      "V1.6.53",
      " v1.6.53",
      "vx.y.z",
      "",
    ]) {
      expect(parseReleaseTag(tag)).toBeNull();
    }
    expect(parseReleaseTag(`v${"9".repeat(40)}.0.0`)).toBeNull();
  });

  it("reads the running version, with or without a suffix", () => {
    expect(parseRunningVersion("1.6.53")).toEqual({ major: 1, minor: 6, patch: 53, preRelease: false });
    expect(parseRunningVersion("1.6.53-dev")).toMatchObject({ preRelease: true });
    expect(parseRunningVersion("1.6.53+local.1")).toMatchObject({ preRelease: true });
    expect(parseRunningVersion("not-a-version")).toBeNull();
    expect(parseRunningVersion(`${"9".repeat(40)}.0.0`)).toBeNull();
  });

  it("compares numerically, not as text", () => {
    const running = (version: string) =>
      parseRunningVersion(version) as NonNullable<ReturnType<typeof parseRunningVersion>>;
    const tag = (value: string) => parseReleaseTag(value) as NonNullable<ReturnType<typeof parseReleaseTag>>;
    expect(isNewerThanRunning(tag("v1.10.0"), running("1.9.9"))).toBe(true);
    expect(isNewerThanRunning(tag("v1.6.100"), running("1.6.99"))).toBe(true);
    expect(isNewerThanRunning(tag("v2.0.0"), running("1.99.99"))).toBe(true);
    expect(isNewerThanRunning(tag("v1.6.53"), running("1.6.53"))).toBe(false);
    expect(isNewerThanRunning(tag("v1.6.52"), running("1.6.53"))).toBe(false);
    expect(isNewerThanRunning(tag("v1.9.0"), running("1.10.0"))).toBe(false);
  });

  it("offers the stable release to a pre-release or development build of the same core", () => {
    const tag = parseReleaseTag("v1.6.53") as NonNullable<ReturnType<typeof parseReleaseTag>>;
    expect(isNewerThanRunning(tag, parseRunningVersion("1.6.53-dev") as never)).toBe(true);
    expect(isNewerThanRunning(tag, parseRunningVersion("1.6.54-dev") as never)).toBe(false);
    expect(isNewerThanRunning(tag, parseRunningVersion("1.6.52-dev") as never)).toBe(true);
  });
});

describe("choosing the release", () => {
  it("picks the highest stable release, whatever the order", () => {
    const outcome = evaluate([{ tag: "v1.6.53" }, { tag: "v1.10.0" }, { tag: "v1.9.9" }, { tag: "v1.10.0" }]);
    expect(outcome.result).toMatchObject({ kind: "newer", version: "1.10.0" });
  });

  it("skips drafts, pre-releases and tags that are not exactly vX.Y.Z", () => {
    const outcome = evaluate([
      { tag: "v9.0.0", draft: true },
      { tag: "v8.0.0", prerelease: true },
      { tag: "v7.0.0-rc.1" },
      { tag: "7.0.0" },
      { tag: "nightly" },
      { tag: "v1.6.53" },
    ]);
    expect(outcome.result).toMatchObject({ kind: "newer", version: "1.6.53" });
  });

  it("says up to date for an equal or lower release, an empty list or nothing stable", () => {
    expect(evaluate([{ tag: "v1.6.52" }]).result).toEqual({ kind: "up-to-date", current: "1.6.52" });
    expect(evaluate([{ tag: "v1.6.51" }]).result.kind).toBe("up-to-date");
    expect(evaluate([]).result.kind).toBe("up-to-date");
    expect(
      evaluate([
        { tag: "v9.9.9", draft: true },
        { tag: "v9.9.8", prerelease: true },
      ]).result.kind,
    ).toBe("up-to-date");
    expect(evaluate([{ tag: "v1.6.52" }]).links).toEqual({ asset: null, page: null });
  });

  it("counts a stable release with the running development build's core as newer", () => {
    expect(evaluate([{ tag: "v1.6.53" }], "1.6.53-dev").result).toMatchObject({ kind: "newer", version: "1.6.53" });
    expect(evaluate([{ tag: "v1.6.53" }], "1.6.53").result.kind).toBe("up-to-date");
  });

  it("is an error when the running version cannot be read", () => {
    expect(evaluate([{ tag: "v1.6.53" }], "garbage").result).toEqual({ kind: "error", reason: "bad-version" });
  });

  it("reports the publish time as ISO text, or null when it is missing or does not parse", () => {
    expect(evaluate([{ tag: "v1.6.53" }]).result).toMatchObject({ publishedAt: "2030-01-02T03:04:05.000Z" });
    expect(evaluate([{ tag: "v1.6.53", published_at: null }]).result).toMatchObject({ publishedAt: null });
    expect(evaluate([{ tag: "v1.6.53", published_at: "yesterday-ish" }]).result).toMatchObject({ publishedAt: null });
  });

  it("returns a result the page's schema accepts, and no URL in it", () => {
    const { result } = evaluate([{ tag: "v1.6.53" }]);
    expect(updateCheckResultSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toContain("http");
  });
});

describe("the installer and the links", () => {
  const winAsset = `${BASE}/download/v1.6.53/Work-Intelligence-1.6.53-win-x64-setup.exe`;

  it("offers the exact installer of each supported platform", () => {
    const cases: [string, string, string, string][] = [
      ["win32", "x64", "windows", winAsset],
      ["darwin", "arm64", "macos", `${BASE}/download/v1.6.53/Work-Intelligence-1.6.53-mac-arm64.dmg`],
      ["darwin", "x64", "macos", `${BASE}/download/v1.6.53/Work-Intelligence-1.6.53-mac-x64.dmg`],
    ];
    for (const [platform, arch, label, url] of cases) {
      const outcome = evaluate([{ tag: "v1.6.53" }], "1.6.52", platform, arch);
      expect(outcome.result).toMatchObject({ kind: "newer", asset: { platform: label } });
      expect(outcome.links).toEqual({ asset: url, page: `${BASE}/tag/v1.6.53` });
    }
  });

  it("offers only the release page on any other platform or architecture", () => {
    for (const [platform, arch] of [
      ["win32", "arm64"],
      ["win32", "ia32"],
      ["linux", "x64"],
      ["linux", "arm64"],
      ["darwin", "ia32"],
      ["freebsd", "x64"],
    ] as const) {
      const outcome = evaluate([{ tag: "v1.6.53" }], "1.6.52", platform, arch);
      expect(outcome.result).toMatchObject({ kind: "newer", asset: null });
      expect(outcome.links).toEqual({ asset: null, page: `${BASE}/tag/v1.6.53` });
      expect(installerAssetFor("1.6.53", platform, arch)).toBeNull();
    }
  });

  it("offers no installer when the release does not list the exact name", () => {
    const assets = installers("v1.6.53").filter((asset) => !asset.name.endsWith(".exe"));
    const renamed = [
      ...assets,
      { name: "work-intelligence-1.6.53-win-x64-setup.exe", browser_download_url: winAsset },
      { name: "Work-Intelligence-1.6.53-win-x64-setup.exe.zip", browser_download_url: `${winAsset}.zip` },
    ];
    const outcome = evaluate([{ tag: "v1.6.53", assets: renamed }]);
    expect(outcome.result).toMatchObject({ asset: null });
    expect(outcome.links.asset).toBeNull();
    expect(outcome.links.page).toBe(`${BASE}/tag/v1.6.53`);
  });

  it("offers no installer when its download URL is not exactly the expected one", () => {
    const wrong = [
      `https://github.com.evil.test/${SLUG}/releases/download/v1.6.53/Work-Intelligence-1.6.53-win-x64-setup.exe`,
      `https://evilgithub.com/${SLUG}/releases/download/v1.6.53/Work-Intelligence-1.6.53-win-x64-setup.exe`,
      `https://github.com/other/repo/releases/download/v1.6.53/Work-Intelligence-1.6.53-win-x64-setup.exe`,
      `http://github.com/${SLUG}/releases/download/v1.6.53/Work-Intelligence-1.6.53-win-x64-setup.exe`,
      `${winAsset}?token=1`,
      `${winAsset}#fragment`,
      `https://user@github.com/${SLUG}/releases/download/v1.6.53/Work-Intelligence-1.6.53-win-x64-setup.exe`,
      `${BASE}/download/v1.6.52/Work-Intelligence-1.6.53-win-x64-setup.exe`,
      "",
    ];
    for (const url of wrong) {
      const assets = installers("v1.6.53").map((asset) =>
        asset.name.endsWith(".exe") ? { ...asset, browser_download_url: url } : asset,
      );
      const outcome = evaluate([{ tag: "v1.6.53", assets }]);
      expect(outcome.result).toMatchObject({ kind: "newer", asset: null });
      expect(outcome.links.asset).toBeNull();
    }
  });

  it("falls back to the releases page when html_url is not the page of this tag", () => {
    for (const html_url of [`${BASE}/tag/v1.6.52`, "https://github.com.evil.test/x", `${BASE}/tag/v1.6.53?x=1`, ""]) {
      const outcome = evaluate([{ tag: "v1.6.53", html_url }]);
      expect(outcome.result.kind).toBe("newer");
      expect(outcome.links.page).toBe(BASE);
      // The installer link does not depend on html_url.
      expect(outcome.links.asset).toBe(winAsset);
    }
  });

  it("offers no page link at all when even the fallback would not pass the validation", () => {
    const outcome = evaluateReleases([release({ tag: "v1.6.53" })], {
      currentVersion: "1.6.52",
      platform: "linux",
      arch: "x64",
      slug: "not a slug/with space",
    });
    expect(outcome.result.kind).toBe("newer");
    expect(outcome.links).toEqual({ asset: null, page: null });
  });
});

describe("isOurReleaseUrl", () => {
  const asset = "Work-Intelligence-1.6.53-mac-arm64.dmg";

  it("accepts the releases page, one release page and one installer download", () => {
    expect(isOurReleaseUrl(BASE)).toBe(true);
    expect(isOurReleaseUrl(`${BASE}/tag/v1.6.53`)).toBe(true);
    expect(isOurReleaseUrl(`${BASE}/download/v1.6.53/${asset}`)).toBe(true);
    expect(isOurReleaseUrl(`${BASE}/download/v1.6.53/Work-Intelligence-1.6.53-win-x64-setup.exe`)).toBe(true);
    expect(isOurReleaseUrl(`${BASE}/download/v1.6.53/Work-Intelligence-1.6.53-mac-x64.dmg`)).toBe(true);
  });

  it("refuses look-alike hosts, other repositories, other schemes and ports", () => {
    for (const url of [
      `https://github.com.evil.test/${SLUG}/releases`,
      `https://evilgithub.com/${SLUG}/releases`,
      `https://www.github.com/${SLUG}/releases`,
      `https://api.github.com/${SLUG}/releases`,
      `https://github.com/other/repo/releases`,
      `https://github.com/ponpon55837/worklog.ai/releases`,
      `http://github.com/${SLUG}/releases`,
      `ftp://github.com/${SLUG}/releases`,
      `javascript:alert(1)`,
      `https://github.com:443/${SLUG}/releases`,
      `https://github.com:8443/${SLUG}/releases`,
      `https://github.com./${SLUG}/releases`,
      `https://GITHUB.com/${SLUG}/releases`,
    ]) {
      expect(isOurReleaseUrl(url), url).toBe(false);
    }
  });

  it("refuses user info, a query, a fragment and an empty query or fragment", () => {
    for (const url of [
      `https://user@github.com/${SLUG}/releases`,
      `https://user:pass@github.com/${SLUG}/releases`,
      `${BASE}?x=1`,
      `${BASE}?`,
      `${BASE}#`,
      `${BASE}#top`,
      `${BASE}/tag/v1.6.53?x=1`,
      `${BASE}/download/v1.6.53/${asset}?x=1`,
    ]) {
      expect(isOurReleaseUrl(url), url).toBe(false);
    }
  });

  it("refuses paths that are not exactly one of the three shapes", () => {
    for (const url of [
      `${BASE}/`,
      `${BASE}/tag/`,
      `${BASE}/tag/v1.6.53/`,
      `${BASE}/tag/v1.6.53/extra`,
      `${BASE}/tag/v1.6`,
      `${BASE}/tag/v1.6.53-rc.1`,
      `${BASE}/latest`,
      `${BASE}/download/v1.6.53`,
      `${BASE}/download/v1.6.53/`,
      `${BASE}/download/v1.6.53/${asset}/extra`,
      `${BASE}/download/v1.6.53/SHA256SUMS.txt`,
      `${BASE}/download/v1.6.53/Work-Intelligence-1.6.52-mac-arm64.dmg`,
      `${BASE}/download/v1.6.53/Work-Intelligence-1.6.53-linux-x64.AppImage`,
      `${BASE}/download/v1.6.53/Work-Intelligence-1.6.53-mac-arm64.dmg.zip`,
      `https://github.com/${SLUG}/releases/../releases`,
      `https://github.com/${SLUG}/releases/tag/v1.6.53/../v1.6.54`,
      `https://github.com/${SLUG}/releases/tag/v1.6.53/%2e%2e/v1.6.54`,
      `https://github.com/${SLUG}/releases/tag/%76%31.6.53`,
      `https://github.com/${SLUG}/releases/download/v1.6.53/%2e%2e/${asset}`,
      `https://github.com/${SLUG}/releases%2Ftag/v1.6.53`,
      `https://github.com/${SLUG}/./releases`,
      `https://github.com/${SLUG}\\releases`,
      `https://github.com//${SLUG}/releases`,
      `https://github.com/${SLUG}`,
      `https://github.com`,
      ``,
      `not a url`,
    ]) {
      expect(isOurReleaseUrl(url), url).toBe(false);
    }
  });
});

describe("sanitizeNotes", () => {
  it("keeps ordinary text, tabs and newlines, and turns CRLF and CR into LF", () => {
    expect(sanitizeNotes("a\r\nb\rc\td\ne")).toEqual({ text: "a\nb\nc\td\ne", truncated: false });
    expect(sanitizeNotes("line\u2028two\u2029three").text).toBe("line\ntwo\nthree");
    expect(sanitizeNotes("").text).toBe("");
  });

  it("removes C0 and C1 control characters", () => {
    const controls = "\u0000\u0001\u0008\u000B\u000C\u000E\u001B\u001F\u007F\u0080\u0085\u009F";
    expect(sanitizeNotes(`a${controls}b`).text).toBe("ab");
  });

  it("removes bidi overrides and isolates, marks and invisible spoofing characters", () => {
    const spoof = "\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u200E\u200F\u061C\u200B\u2060\uFEFF\u{E0041}";
    expect(sanitizeNotes(`exe\u202Egpj.txt${spoof}`).text).toBe("exegpj.txt");
  });

  it("keeps a zero-width joiner only inside an emoji sequence", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    expect(sanitizeNotes(family).text).toBe(family);
    expect(sanitizeNotes("a\u200Db").text).toBe("ab");
    expect(sanitizeNotes("\u200Dstart end\u200D").text).toBe("start end");
    expect(sanitizeNotes("\u{1F468}\u200Dx").text).toBe("\u{1F468}x");
  });

  it("leaves markup as literal text", () => {
    const html = '<img src=x onerror="alert(1)"> <script>alert(2)</script> [link](javascript:alert(3)) **bold**';
    expect(sanitizeNotes(html)).toEqual({ text: html, truncated: false });
  });

  it("caps the text and says so, without splitting a surrogate pair", () => {
    const exact = "x".repeat(NOTES_MAX_CHARACTERS);
    expect(sanitizeNotes(exact)).toEqual({ text: exact, truncated: false });
    const over = sanitizeNotes(`${exact}y`);
    expect(over.truncated).toBe(true);
    expect(over.text).toBe(exact);
    const pair = sanitizeNotes(`${"x".repeat(NOTES_MAX_CHARACTERS - 1)}\u{1F600}tail`);
    expect(pair.truncated).toBe(true);
    expect(pair.text).toBe("x".repeat(NOTES_MAX_CHARACTERS - 1));
  });

  it("is applied to the notes of the chosen release", () => {
    const outcome = evaluate([{ tag: "v1.6.53", body: `a\r\n\u202Eb${"z".repeat(NOTES_MAX_CHARACTERS)}` }]);
    expect(outcome.result).toMatchObject({ kind: "newer", notesTruncated: true });
    expect((outcome.result as { notes: string }).notes.startsWith("a\nb")).toBe(true);
    expect(evaluate([{ tag: "v1.6.53", body: null }]).result).toMatchObject({ notes: "", notesTruncated: false });
  });
});

describe("the IPC contract", () => {
  it("accepts every result kind and refuses extra fields and unknown kinds", () => {
    const good = [
      { kind: "up-to-date", current: "1.6.52" },
      { kind: "offline", timedOut: true },
      { kind: "rate-limited", resetAt: null },
      { kind: "error", reason: "not-json" },
      {
        kind: "newer",
        current: "1.6.52",
        version: "1.6.53",
        publishedAt: null,
        notes: "",
        notesTruncated: false,
        asset: { platform: "macos" },
      },
    ];
    for (const value of good) expect(updateCheckResultSchema.safeParse(value).success).toBe(true);
    expect(updateCheckResultSchema.safeParse({ kind: "up-to-date", current: "1", url: "https://x.test" }).success).toBe(
      false,
    );
    expect(updateCheckResultSchema.safeParse({ kind: "error", reason: "<raw body>" }).success).toBe(false);
    expect(updateCheckResultSchema.safeParse({ kind: "other" }).success).toBe(false);
  });

  it("opens a link only by name, never by URL", () => {
    expect(repairInputSchemas.updateOpenLink.safeParse({ target: "asset" }).success).toBe(true);
    expect(repairInputSchemas.updateOpenLink.safeParse({ target: "page" }).success).toBe(true);
    expect(repairInputSchemas.updateOpenLink.safeParse({ target: "https://github.com" }).success).toBe(false);
    expect(repairInputSchemas.updateOpenLink.safeParse({ target: "page", url: "https://x.test" }).success).toBe(false);
    expect(repairInputSchemas.updateCheck.safeParse({}).success).toBe(true);
    expect(repairInputSchemas.updateCheck.safeParse({ url: "https://x.test" }).success).toBe(false);
  });
});

describe("the tray item and the page state", () => {
  const base = { messages: shellMessages("zh-TW"), owner: "MANAGED" as const, backendRunning: true };

  it("adds 「檢查更新…」 only when the update messages are given", () => {
    expect(buildTrayMenu(base).some((item) => item.id === "check-updates")).toBe(false);
    const menu = buildTrayMenu({ ...base, update: updateMessages("zh-TW") });
    expect(menu.find((item) => item.id === "check-updates")).toEqual({
      id: "check-updates",
      label: "檢查更新…",
      enabled: true,
    });
    expect(menu.at(-1)?.id).toBe("quit");
    const english = buildTrayMenu({ ...base, update: updateMessages("en") });
    expect(english.find((item) => item.id === "check-updates")?.label).toBe("Check for updates…");
  });

  it("has the same strings in both languages, with the required copy in Traditional Chinese", () => {
    const zh = updateMessages("zh-TW");
    const en = updateMessages("en");
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    expect(zh.check).toBe("檢查更新");
    expect(zh.upToDate).toBe("已是最新版本");
    expect(zh.openPage).toBe("開啟發行頁面");
    expect(zh.downloadAsset.windows).toBe("下載 Windows 安裝檔");
    expect(zh.downloadAsset.macos).toBe("下載 macOS 安裝檔");
    expect(zh.notesTruncated).toBe("完整內容請見發行頁面");
    expect(zh.verifyHint).toContain("SHA256SUMS.txt");
  });

  it("carries the update section in the repair state only when main gives one", () => {
    const inputs = {
      platform: "linux" as const,
      homeDirectory: "/home/synthetic",
      locale: "zh-TW" as const,
      owner: "MANAGED" as const,
      backend: "running" as const,
      databasePath: null,
      databaseStatus: "ok" as const,
      candidates: [],
      recentErrors: [],
      lastBackup: { status: "none" as const },
      retryOperationId: "00000000-0000-4000-8000-000000000000",
      busy: false,
    };
    expect(buildRepairState(inputs).update).toBeUndefined();
    expect(buildRepairState({ ...inputs, update: { currentVersion: "1.6.53", startCheck: true } }).update).toEqual({
      currentVersion: "1.6.53",
      startCheck: true,
    });
  });
});
