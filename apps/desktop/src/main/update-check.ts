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
 * 「檢查更新」. Nothing here runs by itself: no timer, no start-up check and nothing kept on disk. A check starts only
 * from a click: the page's button, or the tray item, which starts it here in main (the same single-flight check as the
 * button's) and shows the page. No request is ever left waiting for a page to send it, and the page never starts one
 * from its state: it displays {@link UpdateController.section}. Only a link the request returned and that passes the link
 * check again can be opened in the browser. The page never sends or receives a URL.
 */
export interface UpdateController {
  /** Runs a check; a check already running is joined, so two clicks make one request. */
  check(): Promise<UpdateCheckResult>;
  /** Opens a link of the last answer in the browser; false when there is none, it fails the link check or the system refuses it. */
  openLink(target: UpdateLinkTarget): Promise<boolean>;
  /** The tray item: start the check now (joining one that runs) and show the section. */
  requestFromTray(): void;
  /** What the repair page's 「更新」 card shows: the running version, whether a check runs, and the last answer. */
  section(): RepairUpdateSection;
}

export interface UpdateControllerOptions {
  readonly currentVersion: string;
  readonly fetch: UpdateFetch;
  readonly platform: string;
  readonly arch: string;
  /** Test builds only: the fake server's origin. */
  readonly apiOrigin?: string;
  /** Opens a checked URL in the browser; resolves to whether the system accepted it. */
  readonly openExternal: (url: string) => Promise<boolean>;
  readonly showSection: () => void;
  /** The check started or finished: an open page reads the section again. */
  readonly changed: () => void;
  readonly log: Logger;
}

export function createUpdateController(options: UpdateControllerOptions): UpdateController {
  const { log } = options;
  let running: Promise<UpdateCheckResult> | null = null;
  let last: UpdateOutcome | null = null;

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

  function check(): Promise<UpdateCheckResult> {
    if (running === null) {
      running = run().finally(() => {
        running = null;
        options.changed();
      });
      options.changed();
    }
    return running;
  }

  return {
    check,
    openLink: async (target) => {
      const url = last?.links[target];
      if (!url || !isOurReleaseUrl(url)) return false;
      // A refusal, a rejection or a throw all mean the link did not open; none of them may read as success.
      const opened = await Promise.resolve()
        .then(() => options.openExternal(url))
        .catch(() => false);
      if (!opened) {
        log(`[shell] update link failed: ${target}`);
        return false;
      }
      log(`[shell] update link opened: ${target}`);
      return true;
    },
    requestFromTray: () => {
      // Started here, by this click: no flag waits for a page, so closing the window cannot leave a request behind.
      void check();
      options.showSection();
    },
    section: () => ({
      currentVersion: options.currentVersion,
      checking: running !== null,
      result: running === null ? (last?.result ?? null) : null,
    }),
  };
}
