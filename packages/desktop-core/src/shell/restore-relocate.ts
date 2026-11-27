import path from "node:path";
import { DESKTOP_MAX_RESTORE_REMAPS } from "@work-intelligence/schema";

export interface BackupRoot {
  readonly path: string;
  readonly name: string;
}

export function lastSegment(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

const EXISTENCE_BATCH = 64;

export async function missingRoots(
  roots: readonly BackupRoot[],
  exists: (rootPath: string) => Promise<boolean>,
): Promise<BackupRoot[]> {
  // Batched: a backup may record thousands of folders and a slow or offline drive must not queue them all at once.
  const answers: boolean[] = [];
  for (let start = 0; start < roots.length; start += EXISTENCE_BATCH) {
    const batch = roots.slice(start, start + EXISTENCE_BATCH);
    answers.push(...(await Promise.all(batch.map((root) => exists(root.path).catch(() => false)))));
  }
  return roots.filter((_, index) => !answers[index]);
}

export interface RelocationInputs {
  readonly missing: readonly BackupRoot[];
  readonly chosen: string;
  readonly directoryExists: (folder: string) => Promise<boolean>;
  readonly caseInsensitive?: boolean;
}

export async function planRelocation(inputs: RelocationInputs): Promise<Map<string, string>> {
  const insensitive = inputs.caseInsensitive ?? process.platform === "win32";
  const fold = (value: string): string => (insensitive ? value.toLowerCase() : value);
  const chosenName = fold(lastSegment(inputs.chosen));
  // Ambiguous matches stay unmapped so a restore never points two projects at the same code.
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
  const targets = new Map<string, number>();
  for (const target of mapped.values()) targets.set(fold(target), (targets.get(fold(target)) ?? 0) + 1);
  for (const [from, target] of mapped) if ((targets.get(fold(target)) ?? 0) > 1) mapped.delete(from);
  return mapped;
}

export function remapList(mapped: ReadonlyMap<string, string>): { from: string; to: string }[] {
  return [...mapped.entries()]
    .map(([from, to]) => ({ from, to }))
    .sort((left, right) => right.from.length - left.from.length)
    .slice(0, DESKTOP_MAX_RESTORE_REMAPS);
}
