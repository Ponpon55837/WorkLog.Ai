import fs from "node:fs/promises";
import { SHELL_LOCALES, type ShellLanguagePreference } from "@work-intelligence/schema";
import { z } from "zod";
import { writeFileAtomic } from "../internal/atomic-file.js";
import { resolveShellLocale, type ShellLocale } from "./i18n.js";

/**
 * The App's language choice lives in its own small file next to the settings, never in the settings file: an older App
 * does not read this file, so going back to one never asks for a repair. No file means 「跟隨系統」.
 */
export const LANGUAGE_PREFERENCES_FILE_NAME = "preferences.json";

/** What the file holds. Unknown keys are ignored, so a newer App may add some without this one refusing the file. */
const languagePreferencesSchema = z.object({ language: z.enum(SHELL_LOCALES).optional() });

/** The file is a few bytes; anything much larger is not one this App wrote. */
const MAX_PREFERENCES_BYTES = 4096;

/** The file's language and, when the file could not be used, why (the App then follows the system). */
export interface LanguagePreferenceRead {
  readonly preference: ShellLanguagePreference;
  readonly problem?: "unreadable" | "invalid";
}

/**
 * The one rule for the App's language. A chosen language wins; 「跟隨系統」 reads the system language (`zh-*` is
 * Traditional Chinese, anything else English). Every surface (the window, the tray, the menu, the dialogs, the
 * diagnostics and the Dashboard the App manages) takes its language from here.
 */
export function resolveShellLanguage(
  preference: ShellLanguagePreference,
  systemLocale: string | undefined,
): ShellLocale {
  return preference === "system" ? resolveShellLocale(systemLocale) : preference;
}

/** The language in the file's text; text that is not a preferences file reads as 「跟隨系統」 with a problem. */
export function parseLanguagePreferences(text: string): LanguagePreferenceRead {
  if (text.length > MAX_PREFERENCES_BYTES) return { preference: "system", problem: "invalid" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { preference: "system", problem: "invalid" };
  }
  const parsed = languagePreferencesSchema.safeParse(json);
  if (!parsed.success) return { preference: "system", problem: "invalid" };
  return { preference: parsed.data.language ?? "system" };
}

/** Reads the language file. It never throws: a missing file is 「跟隨系統」, and so is one that cannot be used. */
export async function readLanguagePreference(filePath: string): Promise<LanguagePreferenceRead> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
    return missing ? { preference: "system" } : { preference: "system", problem: "unreadable" };
  }
  return parseLanguagePreferences(text);
}

/**
 * Saves the choice. 「跟隨系統」 removes the file; a language replaces it atomically (a temporary file renamed into
 * place), so a crash leaves the old choice or the new one, never a torn file.
 */
export async function writeLanguagePreference(filePath: string, preference: ShellLanguagePreference): Promise<void> {
  if (preference === "system") {
    await fs.rm(filePath, { force: true });
    return;
  }
  await writeFileAtomic(filePath, `${JSON.stringify({ language: preference }, null, 2)}\n`);
}
