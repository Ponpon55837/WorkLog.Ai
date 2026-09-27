import type { DatabaseSync } from "node:sqlite";
import type {
  Hotspot,
  HotspotGroup,
  HotspotHint,
  HotspotSession,
  ReportVerificationStatus,
} from "@work-intelligence/core";
import { localDayStartIso } from "@work-intelligence/shared";
import { normalizePath, projectRelativePath } from "./search-text.js";
import { nextCalendarDate } from "./session-repository.js";

export interface HotspotOptions {
  projectId?: string;
  from?: string;
  to?: string;
  limit: number;
  groupBy: HotspotGroup;
}

interface HotspotRow {
  project_id: string;
  project_name: string;
  path: string;
  session_count: number;
  failed_count: number;
  not_run_count: number;
  last_changed_at: string;
  session_id: string;
  session_title: string;
  completed_at: string;
  status: ReportVerificationStatus;
}

const RECENT_SESSIONS = 5;
/** A path hint needs this many Sessions within HINT_DAYS before work_get_context mentions it. */
const HINT_MIN_SESSIONS = 3;
const HINT_DAYS = 30;

/*
 * Reads search_paths, where each Session's changed files are already normalized to project-relative paths and
 * a Session listing more than 20 files has weight < 1 (a polluted worktree). Those Sessions, voided Sessions,
 * and non-tracked projects are left out. The directory of a path is everything before its last "/":
 * rtrim(path, <path without "/">) strips the file name, and the second rtrim drops the trailing slash.
 */
const DIRECTORY_KEY = `CASE WHEN instr(sp.path, '/') > 0
  THEN rtrim(rtrim(sp.path, replace(sp.path, '/', '')), '/') ELSE '.' END`;

function touchedSessionsSql(key: string, filters: string[]): string {
  return `SELECT DISTINCT sp.project_id, ${key} AS path, s.id AS session_id, s.title AS session_title,
            s.completed_at, COALESCE(json_extract(s.verification_json, '$.status'), 'not_supplied') AS status
          FROM search_paths sp
          JOIN sessions s ON s.id = sp.doc_id
          JOIN projects p ON p.id = sp.project_id
          WHERE sp.doc_type = 'session' AND sp.weight >= 1 AND p.status = 'tracked' AND s.voided_at IS NULL
            ${filters.map((filter) => `AND ${filter}`).join(" ")}`;
}

export class HotspotRepository {
  public constructor(private readonly db: DatabaseSync) {}

  /** The most changed paths, each with its five newest Sessions, in one query. */
  public hotspots(options: HotspotOptions): Hotspot[] {
    const filters: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.projectId) {
      filters.push("sp.project_id = ?");
      parameters.push(options.projectId);
    }
    if (options.from) {
      filters.push("s.completed_at >= ?");
      parameters.push(localDayStartIso(options.from) ?? options.from);
    }
    if (options.to) {
      filters.push("s.completed_at < ?");
      parameters.push(nextCalendarDate(options.to));
    }
    const key = options.groupBy === "directory" ? DIRECTORY_KEY : "sp.path";
    const rows = this.db
      .prepare(
        `WITH touched AS (${touchedSessionsSql(key, filters)}),
         top AS (
           SELECT project_id, path, COUNT(*) AS session_count, SUM(status = 'failed') AS failed_count,
                  SUM(status = 'not_run') AS not_run_count, MAX(completed_at) AS last_changed_at
           FROM touched GROUP BY project_id, path
           ORDER BY session_count DESC, failed_count DESC, last_changed_at DESC, path ASC
           LIMIT ?
         ),
         recent AS (
           SELECT t.*, ROW_NUMBER() OVER (
             PARTITION BY t.project_id, t.path ORDER BY t.completed_at DESC, t.session_id
           ) AS position
           FROM touched t JOIN top ON top.project_id = t.project_id AND top.path = t.path
         )
         SELECT top.project_id, pr.name AS project_name, top.path, top.session_count, top.failed_count,
                top.not_run_count, top.last_changed_at, recent.session_id, recent.session_title,
                recent.completed_at, recent.status
         FROM top
         JOIN recent ON recent.project_id = top.project_id AND recent.path = top.path AND recent.position <= ?
         JOIN projects pr ON pr.id = top.project_id
         ORDER BY top.session_count DESC, top.failed_count DESC, top.last_changed_at DESC, top.path ASC,
                  recent.position ASC`,
      )
      .all(...parameters, options.limit, RECENT_SESSIONS) as unknown as HotspotRow[];

    // Rows arrive grouped and ordered, so one pass builds each hotspot and its Sessions.
    const hotspots: Hotspot[] = [];
    let current: Hotspot | undefined;
    for (const row of rows) {
      if (!current || current.projectId !== row.project_id || current.path !== row.path) {
        current = {
          projectId: row.project_id,
          projectName: row.project_name,
          path: row.path,
          sessionCount: row.session_count,
          failedCount: row.failed_count,
          notRunCount: row.not_run_count,
          lastChangedAt: row.last_changed_at,
          recentSessions: [],
        };
        hotspots.push(current);
      }
      const session: HotspotSession = {
        id: row.session_id,
        title: row.session_title,
        completedAt: row.completed_at,
        verificationStatus: row.status,
      };
      current.recentSessions.push(session);
    }
    return this.withDisplayPaths(hotspots, options.groupBy);
  }

  /** Paths an Agent is about to change that at least three Sessions changed in the last 30 days. */
  public hints(projectId: string, paths: readonly string[], now = Date.now()): HotspotHint[] {
    const project = this.db.prepare("SELECT name, root_path FROM projects WHERE id = ?").get(projectId) as
      { name: string; root_path: string } | undefined;
    if (!project || paths.length === 0) {
      return [];
    }
    const contexts = [{ name: project.name, rootPath: project.root_path }];
    // Report each hint with the path the Agent passed, not the lower-cased index key.
    const requested = new Map<string, string>();
    for (const path of paths) {
      const key = normalizePath(path, contexts);
      if (key && !requested.has(key)) {
        requested.set(key, path);
      }
    }
    const normalized = [...requested.keys()];
    if (normalized.length === 0) {
      return [];
    }
    const since = new Date(now - HINT_DAYS * 86_400_000).toISOString();
    const rows = this.db
      .prepare(
        `WITH touched AS (${touchedSessionsSql("sp.path", [
          "sp.project_id = ?",
          "sp.path IN (SELECT value FROM json_each(?))",
          "s.completed_at >= ?",
        ])})
         SELECT path, COUNT(*) AS session_count, SUM(status = 'failed') AS failed_count,
                SUM(status = 'not_run') AS not_run_count
         FROM touched GROUP BY path HAVING COUNT(*) >= ?
         ORDER BY session_count DESC, path ASC`,
      )
      .all(projectId, JSON.stringify(normalized), since, HINT_MIN_SESSIONS) as Array<{
      path: string;
      session_count: number;
      failed_count: number;
      not_run_count: number;
    }>;
    return rows.map((row) => ({
      path: requested.get(row.path) ?? row.path,
      days: HINT_DAYS,
      sessionCount: row.session_count,
      failedCount: row.failed_count,
      notRunCount: row.not_run_count,
    }));
  }

  /**
   * search_paths stores lower-cased paths for matching. Each hotspot's newest Session still has the original
   * spelling in changed_files_json, so one query restores it for display.
   */
  private withDisplayPaths(hotspots: Hotspot[], groupBy: HotspotGroup): Hotspot[] {
    const sessionIds = [...new Set(hotspots.map((hotspot) => hotspot.recentSessions[0]?.id).filter(Boolean))];
    if (sessionIds.length === 0) {
      return hotspots;
    }
    const rows = this.db
      .prepare(
        `SELECT s.id, s.changed_files_json, p.name, p.root_path
         FROM sessions s JOIN projects p ON p.id = s.project_id
         WHERE s.id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(sessionIds)) as Array<{
      id: string;
      changed_files_json: string;
      name: string;
      root_path: string;
    }>;
    const spellings = new Map<string, Map<string, string>>();
    for (const row of rows) {
      const contexts = [{ name: row.name, rootPath: row.root_path }];
      const bySession = new Map<string, string>();
      for (const raw of JSON.parse(row.changed_files_json) as string[]) {
        const relative = projectRelativePath(raw, contexts);
        if (!relative) {
          continue;
        }
        const display =
          groupBy === "directory"
            ? relative.includes("/")
              ? relative.slice(0, relative.lastIndexOf("/"))
              : "."
            : relative;
        bySession.set(display.toLowerCase(), display);
      }
      spellings.set(row.id, bySession);
    }
    return hotspots.map((hotspot) => {
      const display = spellings.get(hotspot.recentSessions[0]?.id ?? "")?.get(hotspot.path);
      return display ? { ...hotspot, path: display } : hotspot;
    });
  }
}
