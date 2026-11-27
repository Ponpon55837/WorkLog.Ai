import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { JOURNAL_FILENAME } from "./constants.js";
import { syncDirectory } from "./files.js";

const JOURNAL_ITEM_SCHEMA = z.object({
  path: z.string(),
  label: z.string(),
  mode: z.number().int(),
  beforeFingerprint: z.string(),
  afterFingerprint: z.string(),
  backupPath: z.string().optional(),
  /** True only when this operation created the backup file; a backup that already existed is never ours to delete. */
  backupCreated: z.boolean().optional(),
  /** `writing` is persisted before the item is touched; `written` once the whole operation committed. */
  state: z.enum(["planned", "writing", "written"]),
});

const JOURNAL_SCHEMA = z.object({
  version: z.literal(1),
  operationId: z.string(),
  state: z.enum(["pending", "committed", "compensated", "needs-manual-repair"]),
  startedAt: z.string(),
  items: z.array(JOURNAL_ITEM_SCHEMA),
  createdDirectories: z.array(z.string()),
});

export type AgentSetupJournal = z.infer<typeof JOURNAL_SCHEMA>;
export type AgentSetupJournalItem = z.infer<typeof JOURNAL_ITEM_SCHEMA>;

export type AgentSetupJournalRead =
  { status: "none" } | { status: "unreadable" } | { status: "found"; journal: AgentSetupJournal };

export function agentSetupJournalPath(homeDirectory: string): string {
  return join(homeDirectory, JOURNAL_FILENAME);
}

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
 * is best effort and only narrows the window in which the rename itself is lost.
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
  syncDirectory(dirname(journalPath));
}

export function moveAgentSetupJournalAside(journalPath: string, now: Date = new Date()): string | null {
  const root = `${journalPath}.corrupt-${now.toISOString().replaceAll(/[-:.]/g, "")}`;
  let candidate = root;
  for (let suffix = 1; existsSync(candidate); suffix += 1) candidate = `${root}-${suffix}`;
  try {
    renameSync(journalPath, candidate);
    return candidate;
  } catch {
    return null;
  }
}
