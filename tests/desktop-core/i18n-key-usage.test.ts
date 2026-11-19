import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every message key declared by a desktop-core `*-i18n.ts` file is used by product code outside the i18n files, so a
 * string nobody shows cannot sit in both languages unnoticed.
 */
const ROOT = path.resolve(import.meta.dirname, "../..");
const SHELL = path.join(ROOT, "packages/desktop-core/src/shell");
const PRODUCT_DIRECTORIES = ["packages/desktop-core/src", "apps/desktop/src"];

function productFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return name === "node_modules" || name === "dist" ? [] : productFiles(full);
    return full.endsWith(".ts") && !full.endsWith(".d.ts") ? [full] : [];
  });
}

/** Source without comments, so a key that is only mentioned in a doc comment still counts as unused. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const i18nFiles = readdirSync(SHELL)
  .filter((name) => name.endsWith("-i18n.ts") || name === "i18n.ts")
  .map((name) => path.join(SHELL, name));

const productSources = PRODUCT_DIRECTORIES.flatMap((directory) => productFiles(path.join(ROOT, directory)));
/** Code that reads messages: everything outside the i18n files, plus the i18n files' own helpers (property reads only). */
const usage = productSources
  .filter((file) => !i18nFiles.includes(file))
  .map(code)
  .join("\n");
const helperUsage = i18nFiles.map(code).join("\n");

/** The members of every `interface …Messages` block (nested ones included), by name. */
function declaredKeys(file: string): string[] {
  const keys = new Set<string>();
  for (const block of readFileSync(file, "utf8").matchAll(/export interface \w+ \{([\s\S]*?)\n\}/g)) {
    for (const member of (block[1] as string).matchAll(/^\s+readonly (\w+)\??:/gm)) keys.add(member[1] as string);
  }
  return [...keys];
}

describe("desktop-core i18n keys are used", () => {
  it("finds the i18n files", () => {
    expect(i18nFiles.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of i18nFiles) {
    for (const key of declaredKeys(file)) {
      it(`${path.basename(file)}: ${key}`, () => {
        const access = new RegExp(`\\.${key}\\b|\\[\\s*["'\`]${key}["'\`]`);
        const destructured = new RegExp(`[{,]\\s*${key}\\s*[,}:]`);
        expect(access.test(helperUsage) || access.test(usage) || destructured.test(usage)).toBe(true);
      });
    }
  }
});
