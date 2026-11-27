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

/** A check starts only from a click; the page never sends or receives a URL. */
export interface UpdateController {
  check(): Promise<UpdateCheckResult>;
  openLink(target: UpdateLinkTarget): Promise<boolean>;
  requestFromTray(): void;
  section(): RepairUpdateSection;
}

export interface UpdateControllerOptions {
  readonly currentVersion: string;
  readonly fetch: UpdateFetch;
  readonly platform: string;
  readonly arch: string;
  readonly apiOrigin?: string;
  readonly openExternal: (url: string) => Promise<boolean>;
  readonly showSection: () => void;
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
