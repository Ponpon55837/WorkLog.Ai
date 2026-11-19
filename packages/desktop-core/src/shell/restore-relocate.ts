import path from "node:path";
import { DESKTOP_MAX_RESTORE_REMAPS } from "@work-intelligence/schema";

/**
 * Restoring on a new computer: a backup records where each project lived on the old computer. The ones that do not exist
 * here are matched to a folder the user chose in the native dialog (the same job as the command line's `--remap-root`, with no
 * command). Pure logic: main supplies the existence check, and every path stays in main.
 */

/** One project folder of a backup. */
export interface BackupRoot {
  readonly path: string;
  readonly name: string;
}

/** The last segment of a path written on either OS (a backup from Windows is read on macOS and the reverse). */
export function lastSegment(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

const EXISTENCE_BATCH = 64;

/** Roots that do not exist on this computer, in the order of the backup; a root that is not a usable path is left out. */
export async function missingRoots(
  roots: readonly BackupRoot[],
  exists: (rootPath: string) => Promise<boolean>,
): Promise<BackupRoot[]> {
  // In batches: a backup may record thousands of folders, and a slow or offline drive must not queue them all at once.
  const answers: boolean[] = [];
  for (let start = 0; start < roots.length; start += EXISTENCE_BATCH) {
    const batch = roots.slice(start, start + EXISTENCE_BATCH);
    answers.push(...(await Promise.all(batch.map((root) => exists(root.path).catch(() => false)))));
  }
  return roots.filter((_, index) => !answers[index]);
}

export interface RelocationInputs {
  /** The roots that are still missing and not yet mapped. */
  readonly missing: readonly BackupRoot[];
  /** The folder the user chose in the native dialog. */
  readonly chosen: string;
  /** Whether a folder exists here. */
  readonly directoryExists: (folder: string) => Promise<boolean>;
  /** Windows compares names without case. Default: the platform of this process. */
  readonly caseInsensitive?: boolean;
}

/**
 * Matches each missing project to the chosen folder: the folder itself when it carries the project's name, or a folder of that name
 * inside it. Projects it cannot match stay as they were (restored with their old path, which a later restore may map).
 */
export async function planRelocation(inputs: RelocationInputs): Promise<Map<string, string>> {
  const insensitive = inputs.caseInsensitive ?? process.platform === "win32";
  const fold = (value: string): string => (insensitive ? value.toLowerCase() : value);
  const chosenName = fold(lastSegment(inputs.chosen));
  // Two missing projects with the chosen folder's name (`a/app` and `b/app`) cannot both live in it: the folder itself is not
  // guessed for either, so neither is silently pointed at the wrong code. A folder of that name inside it still matches.
  const sameName = inputs.missing.filter((root) => fold(lastSegment(root.path)) === chosenName).length;
  const mapped = new Map<string, string>();
  await Promise.all(
    inputs.missing.map(async (root) => {
      const name = lastSegment(root.path);
      if (name.length === 0) return;
      if (fold(name) === chosenName && sameName === 1) {
        mapped.set(root.path, inputs.chosen);
        return;
      }
      const inside = path.join(inputs.chosen, name);
      if (await inputs.directoryExists(inside).catch(() => false)) mapped.set(root.path, inside);
    }),
  );
  // Two projects that end up in one folder cannot both be right (`a/app` and `b/app` with the chosen folder holding `app/app`):
  // neither is mapped, so a restore never points two projects at the same code.
  const targets = new Map<string, number>();
  for (const target of mapped.values()) targets.set(fold(target), (targets.get(fold(target)) ?? 0) + 1);
  for (const [from, target] of mapped) if ((targets.get(fold(target)) ?? 0) > 1) mapped.delete(from);
  return mapped;
}

/** The remap list a restore sends: at most `DESKTOP_MAX_RESTORE_REMAPS`, longest source first so a nested project wins. */
export function remapList(mapped: ReadonlyMap<string, string>): { from: string; to: string }[] {
  return [...mapped.entries()]
    .map(([from, to]) => ({ from, to }))
    .sort((left, right) => right.from.length - left.from.length)
    .slice(0, DESKTOP_MAX_RESTORE_REMAPS);
}
