import fs from "node:fs/promises";
import { SHELL_LOCALES, type ShellLanguagePreference } from "@work-intelligence/schema";
import { z } from "zod";
import { writeFileAtomic } from "../internal/atomic-file.js";
import { resolveShellLocale, type ShellLocale } from "./i18n.js";

export const LANGUAGE_PREFERENCES_FILE_NAME = "preferences.json";

const languagePreferencesSchema = z.object({ language: z.enum(SHELL_LOCALES).optional() });

const MAX_PREFERENCES_BYTES = 4096;

export interface LanguagePreferenceRead {
  readonly preference: ShellLanguagePreference;
  readonly problem?: "unreadable" | "invalid";
}

export function resolveShellLanguage(
  preference: ShellLanguagePreference,
  systemLocale: string | undefined,
): ShellLocale {
  return preference === "system" ? resolveShellLocale(systemLocale) : preference;
}

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

export async function writeLanguagePreference(filePath: string, preference: ShellLanguagePreference): Promise<void> {
  if (preference === "system") {
    await fs.rm(filePath, { force: true });
    return;
  }
  await writeFileAtomic(filePath, `${JSON.stringify({ language: preference }, null, 2)}\n`);
}
