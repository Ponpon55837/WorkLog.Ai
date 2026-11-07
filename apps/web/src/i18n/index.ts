import { customRef, type Ref } from "vue";
import zhTW from "./locales/zh-TW.json";

/**
 * Interface strings live in one JSON catalog per locale (`locales/<BCP 47 tag>.json`), nested by area and looked up
 * by a dotted key such as `common.refresh`. Every locale has the same keys (tests/web/i18n/catalog.test.ts checks
 * it); a key missing from the current locale falls back to 繁體中文, then to the key itself, so text is never blank.
 *
 * The locale lives in a module-level ref (not a Pinia store) because pure utils — status maps, label maps,
 * formatters, router meta — translate outside any component or active Pinia. Anything that calls `t()` while
 * rendering or inside a computed re-runs when the locale changes.
 *
 * 繁體中文 is bundled because it is the fallback for every other locale. Other catalogs are separate chunks loaded
 * on demand: assigning `locale.value` fetches the catalog first and only then switches, so no screen ever renders
 * half-translated. `localeReady()` resolves once a pending switch has landed.
 */
export const LOCALES = ["zh-TW", "en-US"] as const;
export type Locale = (typeof LOCALES)[number];
export type MessageParams = Record<string, string | number | boolean | null | undefined>;

type Catalog = { readonly [key: string]: string | Catalog };
/** Every dotted path to a string in a nested catalog. */
type KeyPaths<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : KeyPaths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];
/** A key of the 繁體中文 catalog, the reference every other locale must match. */
export type MessageKey = KeyPaths<typeof zhTW>;

function flatten(catalog: Catalog, prefix = "", into: Record<string, string> = {}): Record<string, string> {
  for (const [key, value] of Object.entries(catalog)) {
    if (typeof value === "string") into[prefix + key] = value;
    else flatten(value, `${prefix}${key}.`, into);
  }
  return into;
}

const catalogs: Partial<Record<Locale, Readonly<Record<string, string>>>> = { "zh-TW": flatten(zhTW) };
const fallbackCatalog = catalogs["zh-TW"] as Readonly<Record<string, string>>;

const catalogLoaders: Record<Exclude<Locale, "zh-TW">, () => Promise<{ default: Catalog }>> = {
  "en-US": () => import("./locales/en-US.json"),
};

let currentLocale: Locale = "zh-TW";
let requestedLocale: Locale = "zh-TW";
let pendingSwitch: Promise<void> = Promise.resolve();

/** Fetches and flattens a locale's catalog once; resolves immediately when it is already loaded. */
export async function loadCatalog(target: Locale): Promise<void> {
  if (catalogs[target] || target === "zh-TW") return;
  catalogs[target] = flatten((await catalogLoaders[target]()).default);
}

/**
 * The active locale. Writing a locale whose catalog is not loaded yet fetches it, then switches; the latest write
 * wins, and a failed fetch leaves the current locale in place.
 */
export const locale: Ref<Locale> = customRef<Locale>((track, trigger) => ({
  get() {
    track();
    return currentLocale;
  },
  set(next) {
    requestedLocale = next;
    if (catalogs[next]) {
      currentLocale = next;
      trigger();
      return;
    }
    pendingSwitch = loadCatalog(next)
      .then(() => {
        if (requestedLocale !== next) return;
        currentLocale = next;
        trigger();
      })
      .catch(() => undefined);
  },
}));

/** Resolves when the most recent locale write has taken effect (immediately when nothing is pending). */
export function localeReady(): Promise<void> {
  return pendingSwitch;
}

/** Each language is named in itself, so it stays recognisable whatever the current locale is. */
export const LOCALE_OPTIONS: ReadonlyArray<{ value: Locale; label: string }> = [
  { value: "zh-TW", label: "繁體中文" },
  { value: "en-US", label: "English" },
];

/** Picks the browser's language on first visit; anything that is not Chinese gets English. */
export function detectLocale(languages: readonly string[] | undefined): Locale {
  const first = languages?.[0];
  if (!first) return "zh-TW";
  return first.toLowerCase().startsWith("zh") ? "zh-TW" : "en-US";
}

export function isLocale(value: unknown): value is Locale {
  return (LOCALES as readonly unknown[]).includes(value);
}

/** The flat key → text map of one locale, for tests and tooling that check catalogs against each other. */
export function catalogEntries(target: Locale): Readonly<Record<string, string>> {
  return catalogs[target] ?? {};
}

function pluralForm(text: string, params: MessageParams): string {
  const [one = text, other = text] = text.split("|");
  const name = /\{(\w+)\}/.exec(other)?.[1];
  return name !== undefined && Number(params[name]) === 1 ? one : other;
}

/**
 * Translates a message key and fills `{name}` placeholders. A message written as "one|other" picks its form from
 * the first number placeholder (Chinese messages have a single form).
 */
export function t(key: MessageKey, params?: MessageParams): string {
  let text = catalogs[locale.value]?.[key] ?? fallbackCatalog[key] ?? key;
  if (!params) return text;
  if (text.includes("|")) text = pluralForm(text, params);
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name] ?? "") : match));
}

/** BCP 47 tag handed to Intl formatters and `<html lang>`; locales are already named by their tag. */
export function intlLocale(): string {
  return locale.value;
}

/**
 * Wraps a constant map of message keys so every read translates with the current locale. Module-level maps are
 * built once; getters keep them reactive without turning every caller into a function call.
 */
export function translatedRecord<K extends string>(record: Record<K, MessageKey>): Record<K, string> {
  const result = {} as Record<K, string>;
  for (const key of Object.keys(record) as K[]) {
    Object.defineProperty(result, key, { enumerable: true, get: () => t(record[key]) });
  }
  return result;
}

/** Same as translatedRecord, for option lists: the named fields hold message keys and translate on every read. */
export function translatedOptions<T extends object, F extends keyof T & string>(
  options: readonly T[],
  ...fields: F[]
): T[] {
  return options.map((option) => {
    const copy = { ...option };
    for (const field of fields) {
      const key = option[field];
      if (typeof key !== "string") continue;
      Object.defineProperty(copy, field, { enumerable: true, get: () => t(key as MessageKey) });
    }
    return copy;
  });
}
