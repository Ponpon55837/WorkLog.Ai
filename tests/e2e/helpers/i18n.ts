import { readFileSync } from "node:fs";

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

export const LANGUAGE_NAMES: Record<Locale, string> = { "zh-TW": "繁體中文", "en-US": "English" };

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

export function dayNameIn(locale: Locale, isoDate: string): string {
  const [year = 0, month = 1, day = 1] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(new Date(year, month - 1, day));
}

export function dayNamePattern(locale: Locale): RegExp {
  const sample = dayNameIn(locale, "2000-01-01").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${sample.replace(/\d+/g, "\\d+").replace(/January/, "\\p{L}+")}$`, "u");
}

/** Text of a message key in 繁體中文, the locale the specs run in (playwright.config.ts sets `locale: "zh-TW"`). */
export function tt(key: MessageKey, params?: Params): string {
  return textIn("zh-TW", key, params);
}

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
