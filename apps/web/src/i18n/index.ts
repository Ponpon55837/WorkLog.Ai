import { ref } from "vue";
import enUS from "./locales/en-US.json";

/**
 * Gettext-style localisation: the 繁體中文 source text is the message key, and each other locale maps it to a
 * translation in `locales/<BCP 47 tag>.json` (a flat `{ "原文": "translation" }` object). Missing translations fall back to the source text, so an untranslated string is never blank.
 *
 * The locale lives in a module-level ref (not a Pinia store) because pure utils — status maps, label maps,
 * formatters, router meta — translate outside any component or active Pinia. Anything that calls `t()` while
 * rendering or inside a computed re-runs when the locale changes.
 */
export const LOCALES = ["zh-TW", "en-US"] as const;
export type Locale = (typeof LOCALES)[number];
export type MessageParams = Record<string, string | number | boolean | null | undefined>;

export const locale = ref<Locale>("zh-TW");

const catalogs: Record<Exclude<Locale, "zh-TW">, Readonly<Record<string, string>>> = { "en-US": enUS };

/** Each language is named in itself, so it stays recognisable whatever the current locale is. */
export const LOCALE_OPTIONS: ReadonlyArray<{ value: Locale; label: string }> = [
  { value: "zh-TW", label: "繁體中文" },
  { value: "en-US", label: "English" },
];

/**
 * Translates a source string that means different things in different places (週 is both the "Week" tab and the
 * "weeks" unit). The catalog key is `context|source`; Chinese shows the source unchanged.
 */
export function tc(context: string, source: string, params?: MessageParams): string {
  if (locale.value === "zh-TW") return t(source, params);
  const key = `${context}|${source}`;
  return key in catalogs[locale.value] ? t(key, params) : t(source, params);
}

/** Picks the browser's language on first visit; anything that is not Chinese gets English. */
export function detectLocale(languages: readonly string[] | undefined): Locale {
  const first = languages?.[0];
  if (!first) return "zh-TW";
  return first.toLowerCase().startsWith("zh") ? "zh-TW" : "en-US";
}

export function isLocale(value: unknown): value is Locale {
  return (LOCALES as readonly unknown[]).includes(value);
}

function pluralForm(text: string, params: MessageParams): string {
  const [one = text, other = text] = text.split("|");
  const name = /\{(\w+)\}/.exec(other)?.[1];
  return name !== undefined && Number(params[name]) === 1 ? one : other;
}

/** Translates a source string and fills `{name}` placeholders. */
export function t(source: string, params?: MessageParams): string {
  const current = locale.value;
  let text = current === "zh-TW" ? source : (catalogs[current][source] ?? source);
  if (!params) return text;
  // A translation written as "one|other" picks its form from the first number placeholder (Chinese has one form).
  if (current !== "zh-TW" && text.includes("|")) text = pluralForm(text, params);
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name] ?? "") : match));
}

/** BCP 47 tag handed to Intl formatters and `<html lang>`; locales are already named by their tag. */
export function intlLocale(): string {
  return locale.value;
}

/**
 * Wraps a constant label map so every read translates with the current locale. Module-level maps are built
 * once; getters keep them reactive without turning every caller into a function call.
 */
export function translatedRecord<K extends string>(record: Record<K, string>): Record<K, string> {
  const result = {} as Record<K, string>;
  for (const key of Object.keys(record) as K[]) {
    Object.defineProperty(result, key, { enumerable: true, get: () => t(record[key]) });
  }
  return result;
}

/**
 * Same as translatedRecord, for option lists: the named text fields translate on every read. Pass a `context`
 * first (see tc) when the list's wording differs from the same source text elsewhere.
 */
export function translatedOptions<T extends object, F extends keyof T & string>(
  options: readonly T[],
  ...fields: F[]
): T[] {
  return translatedOptionsIn("", options, ...fields);
}

export function translatedOptionsIn<T extends object, F extends keyof T & string>(
  context: string,
  options: readonly T[],
  ...fields: F[]
): T[] {
  return options.map((option) => {
    const copy = { ...option };
    for (const field of fields) {
      const source = option[field];
      if (typeof source !== "string") continue;
      Object.defineProperty(copy, field, {
        enumerable: true,
        get: () => (context ? tc(context, source) : t(source)),
      });
    }
    return copy;
  });
}
