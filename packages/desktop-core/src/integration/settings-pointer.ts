import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../internal/atomic-file.js";
import { DESKTOP_SETTINGS_POINTER_FILE_NAME, isUsablePath } from "../runtime/desktop-database.js";

/**
 * Records where the App's settings file is, atomically, unless the pointer already says so. Called by the App once its
 * runtime is current (the same moment it writes desktop-integration.json).
 */
export async function writeDesktopSettingsPointer(
  launcherRoot: string,
  settingsFile: string,
  platform: NodeJS.Platform = process.platform,
): Promise<"written" | "unchanged"> {
  if (!isUsablePath(settingsFile, platform)) {
    throw new RangeError("the desktop settings path must be a normalized absolute path");
  }
  const pointerFile = path.join(launcherRoot, DESKTOP_SETTINGS_POINTER_FILE_NAME);
  const text = `${settingsFile}\n`;
  try {
    if ((await fs.readFile(pointerFile, "utf8")) === text) return "unchanged";
  } catch {
    // Missing or unreadable: write it.
  }
  await writeFileAtomic(pointerFile, text);
  return "written";
}
