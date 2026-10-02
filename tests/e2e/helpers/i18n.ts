import { readFileSync } from "node:fs";

/**
 * Interface text for browser tests, read from the same JSON catalogs the app uses so specs never hard-code copy.
 * Mirrors `t()` in apps/web/src/i18n: `{name}` placeholders and "one|other" plural forms.
 */
type Catalog = { readonly [key: string]: string | Catalog };
type KeyPaths<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : KeyPaths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];
export type MessageKey = KeyPaths<
  typeof import("../../../apps/web/src/i18n/locales/zh-TW.json", { with: { "resolution-mode": "import" } })
>;
export type Locale = "zh-TW" | "en-US";
type Params = Record<string, string | number>;

function flatten(catalog: Catalog, prefix = "", into: Record<string, string> = {}): Record<string, string> {
  for (const [key, value] of Object.entries(catalog)) {
    if (typeof value === "string") into[prefix + key] = value;
    else flatten(value, `${prefix}${key}.`, into);
  }
  return into;
}

function load(locale: Locale): Record<string, string> {
  const url = new URL(`../../../apps/web/src/i18n/locales/${locale}.json`, import.meta.url);
  return flatten(JSON.parse(readFileSync(url, "utf8")) as Catalog);
}

const catalogs: Record<Locale, Record<string, string>> = { "zh-TW": load("zh-TW"), "en-US": load("en-US") };

/** Each language's name in itself, as the language menu shows it (LOCALE_OPTIONS in apps/web/src/i18n). */
export const LANGUAGE_NAMES: Record<Locale, string> = { "zh-TW": "繁體中文", "en-US": "English" };

/** Text of a message key in the given locale. */
export function textIn(locale: Locale, key: MessageKey, params?: Params): string {
  let text = catalogs[locale][key];
  if (text === undefined) throw new Error(`Unknown message key: ${key}`);
  if (!params) return text;
  if (text.includes("|")) {
    const [one = text, other = text] = text.split("|");
    const name = /\{(\w+)\}/.exec(other)?.[1];
    text = name !== undefined && Number(params[name]) === 1 ? one : other;
  }
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/** Text of a message key in 繁體中文, the locale the specs run in (playwright.config.ts sets `locale: "zh-TW"`). */
export function tt(key: MessageKey, params?: Params): string {
  return textIn("zh-TW", key, params);
}

/**
 * A RegExp for a message whose placeholders are not all known: given params are filled in, the remaining
 * `{name}` placeholders match any text. Use it for accessible names and texts with counts, dates or file names.
 */
export function ttPattern(key: MessageKey, params: Params = {}, flags = ""): RegExp {
  const template = tt(key);
  const escaped = template
    .split(/(\{\w+\})/)
    .map((part) => {
      const name = /^\{(\w+)\}$/.exec(part)?.[1];
      if (name === undefined) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return name in params ? String(params[name]).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : ".+?";
    })
    .join("");
  return new RegExp(escaped, flags);
}
