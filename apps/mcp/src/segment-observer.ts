import { resolve } from "node:path";

export interface ObservedSegmentStart {
  at: string;
  tool: string;
  headCommit?: string;
}

/** Oldest project is dropped first so a long-lived process stays bounded. */
const MAX_OBSERVED_PROJECTS = 64;

/** @internal test-only */
export function segmentObserverKey(projectRoot: string): string {
  const key = resolve(projectRoot);
  return process.platform === "win32" ? key.toLowerCase() : key;
}

function evictOldest(entries: Map<string, unknown>, limit: number): void {
  if (entries.size < limit) return;
  const oldest = entries.keys().next();
  if (!oldest.done) entries.delete(oldest.value);
}

/** One Claude Desktop process may serve several chats, so the observed start can predate the conversation; the store labels and caps it. */
export class SegmentObserver {
  private readonly starts = new Map<string, ObservedSegmentStart>();
  private readonly lastSaves = new Map<string, string>();

  public constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly maxProjects: number = MAX_OBSERVED_PROJECTS,
  ) {}

  public record(projectRoot: string, tool: string, headCommit?: () => string | undefined): void {
    const key = segmentObserverKey(projectRoot);
    if (this.starts.has(key)) return;
    evictOldest(this.starts, this.maxProjects);
    let head: string | undefined;
    try {
      head = headCommit?.();
    } catch {
      head = undefined;
    }
    this.starts.set(key, { at: this.now().toISOString(), tool, ...(head ? { headCommit: head } : {}) });
  }

  public peek(projectRoot: string): ObservedSegmentStart | undefined {
    return this.starts.get(segmentObserverKey(projectRoot));
  }

  public lastSaveAt(projectRoot: string): string | undefined {
    return this.lastSaves.get(segmentObserverKey(projectRoot));
  }

  public reset(projectRoot: string): void {
    const key = segmentObserverKey(projectRoot);
    this.starts.delete(key);
    this.lastSaves.delete(key);
    evictOldest(this.lastSaves, this.maxProjects);
    this.lastSaves.set(key, this.now().toISOString());
  }
}
