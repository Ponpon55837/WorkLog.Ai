import { afterEach, describe, expect, it } from "vitest";
import { nextTick, watchEffect } from "vue";
import enUS from "../../../apps/web/src/i18n/locales/en-US.json";
import { detectLocale, locale, t, tc, translatedOptions, translatedRecord } from "../../../apps/web/src/i18n/index.js";
import { verificationStatus } from "../../../apps/web/src/utils/status.js";

// Every web source file except the catalogs themselves, read as text.
const SOURCES = import.meta.glob(["../../../apps/web/src/**/*.{ts,vue}", "!../../../apps/web/src/i18n/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

/** Every quoted string containing Chinese, comments excluded; template attribute values are scanned as code. */
function collectSourceStrings(code: string, found: Set<string>): void {
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
      if (code[end] === quote && CJK.test(text)) {
        if (/['`]/.test(text)) collectSourceStrings(text, found);
        else found.add(text);
      }
      index = end + 1;
    } else {
      index += 1;
    }
  }
}

afterEach(() => {
  locale.value = "zh-TW";
});

describe("English catalog", () => {
  const sources = new Set<string>();
  for (const code of Object.values(SOURCES)) collectSourceStrings(code, sources);

  it("reads the web sources", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
  });

  it("translates every 繁體中文 string in the web UI", () => {
    const missing = [...sources].filter((source) => !(source in enUS));
    expect(missing).toEqual([]);
  });

  it("has no entries the code no longer uses", () => {
    const unused = Object.keys(enUS).filter((key) => !sources.has(key) && !/^\w[\w ]*\|/.test(key));
    expect(unused).toEqual([]);
  });

  it("keeps every {placeholder} of the source string", () => {
    const placeholders = (text: string) => [...new Set(text.match(/\{\w+\}/g) ?? [])].sort();
    const broken = Object.entries(enUS).filter(([key, value]) => {
      const source = /^\w[\w ]*\|/.test(key) ? key.slice(key.indexOf("|") + 1) : key;
      return placeholders(source).join() !== placeholders(value).join();
    });
    expect(broken).toEqual([]);
  });
});

describe("t()", () => {
  it("returns the source text in Chinese and the catalog text in English", () => {
    expect(t("重新整理")).toBe("重新整理");
    locale.value = "en-US";
    expect(t("重新整理")).toBe("Refresh");
  });

  it("fills placeholders and falls back to the source for unknown strings", () => {
    locale.value = "en-US";
    expect(t("{name} 的位置已更新。", { name: "WorkLog" })).toBe("Location of WorkLog updated.");
    expect(t("尚未翻譯 {name}", { name: "x" })).toBe("尚未翻譯 x");
  });

  it("picks the singular English form for a count of one", () => {
    expect(t("{value} 個檔案", { value: 1 })).toBe("1 個檔案");
    locale.value = "en-US";
    expect(t("{value} 個檔案", { value: 1 })).toBe("1 file");
    expect(t("{value} 個檔案", { value: "1" })).toBe("1 file");
    expect(t("{value} 個檔案", { value: 3 })).toBe("3 files");
  });

  it("uses a context entry only where the same source means something else", () => {
    locale.value = "en-US";
    expect(tc("unit", "週")).toBe("weeks");
    expect(t("週")).toBe("Week");
  });

  it("keeps constant label maps in step with the locale", async () => {
    const labels = translatedRecord({ ok: "正常" });
    const [option] = translatedOptions([{ value: "a", label: "全部" }], "label");
    const seen: string[] = [];
    const stop = watchEffect(() => seen.push(verificationStatus.passed.label));
    expect(labels.ok).toBe("正常");
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
