import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { JOURNAL_FILENAME } from "./constants.js";

const JOURNAL_ITEM_SCHEMA = z.object({
  path: z.string(),
  label: z.string(),
  mode: z.number().int(),
  beforeFingerprint: z.string(),
  afterFingerprint: z.string(),
  /** Where the original bytes were copied; absent when the file did not exist before. */
  backupPath: z.string().optional(),
  /** `writing` is persisted before the item is touched; `written` once the whole operation committed. */
  state: z.enum(["planned", "writing", "written"]),
});

const JOURNAL_SCHEMA = z.object({
  version: z.literal(1),
  operationId: z.string(),
  state: z.enum(["pending", "committed", "compensated", "needs-manual-repair"]),
  startedAt: z.string(),
  items: z.array(JOURNAL_ITEM_SCHEMA),
  /** Directories this operation created, removed again when everything is compensated. */
  createdDirectories: z.array(z.string()),
});

/** The durable record of one apply: written before the first write, finalised when it commits or is compensated. */
export type AgentSetupJournal = z.infer<typeof JOURNAL_SCHEMA>;
export type AgentSetupJournalItem = z.infer<typeof JOURNAL_ITEM_SCHEMA>;

export type AgentSetupJournalRead =
  { status: "none" } | { status: "unreadable" } | { status: "found"; journal: AgentSetupJournal };

/** The journal sits next to the setup manifest in the home directory. */
export function agentSetupJournalPath(homeDirectory: string): string {
  return join(homeDirectory, JOURNAL_FILENAME);
}

/** Never throws: a missing file is `none`, a file that is not a journal of this version is `unreadable`. */
export function readAgentSetupJournal(journalPath: string): AgentSetupJournalRead {
  let text: string;
  try {
    text = readFileSync(journalPath, "utf8");
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
      ? { status: "none" }
      : { status: "unreadable" };
  }
  try {
    const parsed = JOURNAL_SCHEMA.safeParse(JSON.parse(text));
    return parsed.success ? { status: "found", journal: parsed.data } : { status: "unreadable" };
  } catch {
    return { status: "unreadable" };
  }
}

/**
 * Temp file, fsync, rename: a crash leaves the previous journal or the new one, never a torn file. The directory sync
 * is best effort (Windows cannot open a directory) and only narrows the window in which the rename itself is lost.
 */
export function writeAgentSetupJournal(journalPath: string, journal: AgentSetupJournal): void {
  mkdirSync(dirname(journalPath), { recursive: true });
  const temporaryPath = `${journalPath}.tmp-${randomUUID()}`;
  try {
    const descriptor = openSync(temporaryPath, "wx", 0o600);
    try {
      writeSync(descriptor, JSON.stringify(journal, null, 2) + "\n");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, journalPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  try {
    const directory = openSync(dirname(journalPath), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch {
    // Not every platform can sync a directory; the file itself is already durable.
  }
}
