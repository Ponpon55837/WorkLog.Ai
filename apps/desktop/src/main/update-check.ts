import {
  checkForUpdates,
  isOurReleaseUrl,
  updateCheckResultSchema,
  type RepairUpdateSection,
  type UpdateCheckResult,
  type UpdateFetch,
  type UpdateLinkTarget,
  type UpdateOutcome,
} from "@work-intelligence/desktop-core";
import type { Logger } from "./log.js";

/**
 * 「檢查更新」. Nothing here runs by itself: no timer, no start-up check and nothing kept on disk. One click of the button
 * (or of the tray item, which opens the page and lets the page press it) makes one request, and only a link that request
 * returned and that passes the link check again can be opened in the browser. The page never sends or receives a URL.
 */
export interface UpdateController {
  /** Runs a check; a check already running is joined, so two clicks make one request. */
  check(): Promise<UpdateCheckResult>;
  /** Opens a link of the last answer in the browser; false when there is none or it fails the link check. */
  openLink(target: UpdateLinkTarget): boolean;
  /** The tray item: show the section and have the page start the check. */
  requestFromTray(): void;
  /** What the repair page's 「更新」 card shows. */
  section(): RepairUpdateSection;
}

export interface UpdateControllerOptions {
  readonly currentVersion: string;
  readonly fetch: UpdateFetch;
  readonly platform: string;
  readonly arch: string;
  /** Test builds only: the fake server's origin. */
  readonly apiOrigin?: string;
  readonly openExternal: (url: string) => void;
  readonly showSection: () => void;
  readonly log: Logger;
}

export function createUpdateController(options: UpdateControllerOptions): UpdateController {
  const { log } = options;
  let running: Promise<UpdateCheckResult> | null = null;
  let last: UpdateOutcome | null = null;
  /** The tray asked for a check and no state has carried that to a page yet. */
  let startPending = false;

  async function run(): Promise<UpdateCheckResult> {
    const outcome = await checkForUpdates({
      fetch: options.fetch,
      currentVersion: options.currentVersion,
      platform: options.platform,
      arch: options.arch,
      ...(options.apiOrigin === undefined ? {} : { apiOrigin: options.apiOrigin }),
    }).catch((): UpdateOutcome => ({
      result: { kind: "error", reason: "unexpected" },
      links: { asset: null, page: null },
    }));
    // What leaves main is checked once more, so the page can rely on its shape.
    last = updateCheckResultSchema.safeParse(outcome.result).success
      ? outcome
      : { result: { kind: "error", reason: "bad-shape" }, links: { asset: null, page: null } };
    log(`[shell] update check finished: ${last.result.kind}`);
    return last.result;
  }

  return {
    check: () => {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },
    openLink: (target) => {
      const url = last?.links[target];
      if (!url || !isOurReleaseUrl(url)) return false;
      log(`[shell] update link opened: ${target}`);
      options.openExternal(url);
      return true;
    },
    requestFromTray: () => {
      startPending = true;
      options.showSection();
    },
    section: () => {
      const startCheck = startPending;
      startPending = false;
      return { currentVersion: options.currentVersion, startCheck };
    },
  };
}
