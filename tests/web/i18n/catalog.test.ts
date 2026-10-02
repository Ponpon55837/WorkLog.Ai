import { afterEach, describe, expect, it } from "vitest";
import { nextTick, watchEffect } from "vue";
import {
  catalogEntries,
  detectLocale,
  locale,
  t,
  translatedOptions,
  translatedRecord,
} from "../../../apps/web/src/i18n/index.js";
import { verificationStatus } from "../../../apps/web/src/utils/status.js";

// Every web source file except the catalogs themselves, read as text.
const SOURCES = import.meta.glob(["../../../apps/web/src/**/*.{ts,vue}", "!../../../apps/web/src/i18n/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
const KEY = /^[a-z][A-Za-z]*(\.[A-Za-z0-9]+)+$/;
/** Chinese literals that are data, not interface text: they are compared against stored records as written. */
const DATA_MARKERS = new Set(["資料不足"]);

/** Every quoted string, comments excluded; template attribute values are scanned as code. */
function collectStrings(code: string, found: string[]): void {
  let index = 0;
  while (index < code.length) {
    if (code.startsWith("//", index) && code[index - 1] !== ":") {
      const end = code.indexOf("\n", index);
      if (end < 0) return;
      index = end;
    } else if (code.startsWith("/*", index)) {
      index = code.indexOf("*/", index) + 2;
    } else if (code.startsWith("<!--", index)) {
      index = code.indexOf("-->", index) + 3;
    } else if (code[index] === '"' || code[index] === "'") {
      const quote = code[index];
      let end = index + 1;
      let text = "";
      while (end < code.length && code[end] !== quote && code[end] !== "\n") {
        if (code[end] === "\\") {
          text += code[end + 1];
          end += 2;
        } else {
          text += code[end];
          end += 1;
        }
      }
      if (code[end] === quote) {
        if (/['`]/.test(text) && /\bt\(/.test(text)) collectStrings(text, found);
        else found.push(text);
      }
      index = end + 1;
    } else {
      index += 1;
    }
  }
}

function placeholders(text: string): string {
  return [...new Set(text.match(/\{\w+\}/g) ?? [])].sort().join();
}

afterEach(() => {
  locale.value = "zh-TW";
});

describe("message catalogs", () => {
  const strings: string[] = [];
  for (const code of Object.values(SOURCES)) collectStrings(code, strings);
  const zhTW = catalogEntries("zh-TW");
  const enUS = catalogEntries("en-US");

  it("reads the web sources", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
  });

  it("gives zh-TW and en-US the same keys", () => {
    expect(Object.keys(enUS).filter((key) => !(key in zhTW))).toEqual([]);
    expect(Object.keys(zhTW).filter((key) => !(key in enUS))).toEqual([]);
  });

  it("keeps every {placeholder} in both languages and leaves no message empty", () => {
    const broken = Object.keys(zhTW).filter((key) => placeholders(zhTW[key]!) !== placeholders(enUS[key] ?? ""));
    expect(broken).toEqual([]);
    expect(Object.keys(zhTW).filter((key) => !zhTW[key] || !enUS[key])).toEqual([]);
  });

  it("keeps interface text out of the code: no Chinese literal outside the catalogs", () => {
    const hardCoded = strings.filter((text) => CJK.test(text) && !DATA_MARKERS.has(text));
    expect(hardCoded).toEqual([]);
  });

  it("has no keys the code no longer uses", () => {
    const used = new Set(strings.filter((text) => KEY.test(text)));
    expect(Object.keys(zhTW).filter((key) => !used.has(key))).toEqual([]);
  });

  // A key missing from the catalogs is a type error: t() only accepts MessageKey, so vue-tsc catches it.
});

describe("t()", () => {
  it("returns the current locale's text", () => {
    expect(t("common.refresh")).toBe("重新整理");
    locale.value = "en-US";
    expect(t("common.refresh")).toBe("Refresh");
  });

  it("fills placeholders", () => {
    expect(t("projects.locationOfUpdated", { name: "WorkLog" })).toBe("WorkLog 的位置已更新。");
    locale.value = "en-US";
    expect(t("projects.locationOfUpdated", { name: "WorkLog" })).toBe("Location of WorkLog updated.");
  });

  it("picks the singular English form for a count of one", () => {
    expect(t("common.files", { value: 1 })).toBe("1 個檔案");
    locale.value = "en-US";
    expect(t("common.files", { value: 1 })).toBe("1 file");
    expect(t("common.files", { value: "1" })).toBe("1 file");
    expect(t("common.files", { value: 3 })).toBe("3 files");
  });

  it("gives words with two meanings their own keys", () => {
    locale.value = "en-US";
    expect(t("reports.unit.weeks")).toBe("weeks");
    expect(t("common.week")).toBe("Week");
  });

  it("keeps constant label maps in step with the locale", async () => {
    const labels = translatedRecord({ ok: "status.healthy" });
    const [option] = translatedOptions([{ value: "a", label: "showcase.all" }], "label");
    const seen: string[] = [];
    const stop = watchEffect(() => seen.push(verificationStatus.passed.label));
    expect(labels.ok).toBe(t("status.healthy"));
    locale.value = "en-US";
    await nextTick();
    expect(labels.ok).toBe("Healthy");
    expect(option?.label).toBe("All");
    expect(seen).toEqual(["通過", "Passed"]);
    stop();
  });
});

describe("detectLocale", () => {
  it("picks Chinese for any zh browser language and English otherwise", () => {
    expect(detectLocale(["zh-TW", "en"])).toBe("zh-TW");
    expect(detectLocale(["zh-CN"])).toBe("zh-TW");
    expect(detectLocale(["en-US", "zh-TW"])).toBe("en-US");
    expect(detectLocale(["ja"])).toBe("en-US");
    expect(detectLocale(undefined)).toBe("zh-TW");
    expect(detectLocale([])).toBe("zh-TW");
  });
});
