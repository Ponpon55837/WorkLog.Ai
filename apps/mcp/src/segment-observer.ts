import { resolve } from "node:path";

/** The first call the server saw for a project since its last save: an observed fact, labelled with its tool. */
export interface ObservedSegmentStart {
  at: string;
  tool: string;
  /** HEAD commit of a tracked project when the segment began; the base for Git change observation. */
  headCommit?: string;
}

/** Entries kept at once; the oldest project is dropped first so a long-lived process stays bounded. */
const MAX_OBSERVED_PROJECTS = 64;

/** Normalizes a workspace root so the same folder always maps to one key. */
export function segmentObserverKey(projectRoot: string): string {
  // resolve() already drops trailing separators except on a filesystem root.
  const key = resolve(projectRoot);
  return process.platform === "win32" ? key.toLowerCase() : key;
}

/**
 * Remembers, per project and only in memory, when this MCP server instance first saw a call since the last
 * successful save. That time is a fact the server observed, never an estimate. One Claude Desktop process may serve
 * several chats, so the value can predate the current conversation; it is labelled and capped by the store.
 */
export class SegmentObserver {
  private readonly starts = new Map<string, ObservedSegmentStart>();

  public constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly maxProjects: number = MAX_OBSERVED_PROJECTS,
  ) {}

  /**
   * Records the call time for a project that has no open segment; later calls keep the first one. `headCommit` is
   * called only when a new entry is created, so later calls cost nothing; a failure just leaves it out.
   */
  public record(projectRoot: string, tool: string, headCommit?: () => string | undefined): void {
    const key = segmentObserverKey(projectRoot);
    if (this.starts.has(key)) return;
    if (this.starts.size >= this.maxProjects) {
      const oldest = this.starts.keys().next();
      if (!oldest.done) this.starts.delete(oldest.value);
    }
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

  /** Ends the segment after a successful save so the next call starts a new one. */
  public reset(projectRoot: string): void {
    this.starts.delete(segmentObserverKey(projectRoot));
  }
}
