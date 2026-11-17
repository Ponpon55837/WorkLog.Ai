import type { SystemDesktopStatus } from "@work-intelligence/core";
import type { DesktopFacts } from "@work-intelligence/schema";
import type { DesktopRouteServices } from "./routes/router.js";

/** Desktop-child mode as the API handler sees it; undefined options mean a standalone server. */
export interface DesktopHandlerOptions {
  /** Facts the App passed in its `start` message. */
  facts?: DesktopFacts;
  /** Tells the App to open its Agent setup window. It never writes any Agent config. */
  onOpenAgentSetup: () => void;
  /** Clock for the throttle; injectable for tests. */
  now?: () => number;
}

/** At most one message to the App per interval, however often the endpoint is called. */
export const OPEN_AGENT_SETUP_MIN_INTERVAL_MS = 1000;

export function createDesktopRouteServices(options: DesktopHandlerOptions): DesktopRouteServices {
  const now = options.now ?? Date.now;
  let lastSentAt: number | undefined;
  const status: SystemDesktopStatus = {
    managed: true,
    ...(options.facts?.legacyService ? { legacyService: options.facts.legacyService } : {}),
  };
  return {
    status,
    requestOpenAgentSetup() {
      const at = now();
      if (lastSentAt !== undefined && at - lastSentAt < OPEN_AGENT_SETUP_MIN_INTERVAL_MS) return;
      lastSentAt = at;
      try {
        options.onOpenAgentSetup();
      } catch {
        // The App not being reachable must not turn the click into a server error.
      }
    },
  };
}
