import type { SystemDesktopStatus } from "@work-intelligence/core";
import {
  sanitizeBrowserPreferences,
  sanitizeHandoffRoute,
  type BrowserPreferences,
  type DesktopFacts,
} from "@work-intelligence/schema";
import type { DesktopRouteServices } from "./routes/router.js";

/** Desktop-child mode as the API handler sees it; undefined options mean a standalone server. */
export interface DesktopHandlerOptions {
  /** Facts the App passed in its `start` message. */
  facts?: DesktopFacts;
  /** Reads the current facts on every request; takes precedence over `facts` because the App can update them after start. */
  getFacts?: () => DesktopFacts | undefined;
  /** Tells the App to open its Agent setup window. It never writes any Agent config. */
  onOpenAgentSetup: () => void;
  /** Tells the App to open its port settings with the page's already sanitized preferences and route. */
  onOpenPortSettings?: (handoff: { preferences: BrowserPreferences; route: string }) => void;
  /** Clock for the throttle; injectable for tests. */
  now?: () => number;
}

/** At most one message to the App per interval, however often the endpoint is called. */
export const OPEN_AGENT_SETUP_MIN_INTERVAL_MS = 1000;

/** The same limit for the port settings request. */
export const OPEN_PORT_SETTINGS_MIN_INTERVAL_MS = 1000;

export function createDesktopRouteServices(
  options: DesktopHandlerOptions,
  backupDirectory?: string,
): DesktopRouteServices {
  const now = options.now ?? Date.now;
  let lastSentAt: number | undefined;
  let lastPortSettingsSentAt: number | undefined;
  const currentStatus = (): SystemDesktopStatus => {
    const facts = options.getFacts ? options.getFacts() : options.facts;
    return {
      managed: true,
      ...(facts?.legacyService ? { legacyService: facts.legacyService } : {}),
      ...(facts?.activePort === undefined ? {} : { activePort: facts.activePort }),
      ...(facts?.loginItem ? { loginItem: facts.loginItem } : {}),
      ...(backupDirectory ? { backupDirectory } : {}),
      ...(facts?.storageRisk ? { storageRisk: facts.storageRisk } : {}),
    };
  };
  return {
    get status() {
      return currentStatus();
    },
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
    requestOpenPortSettings(handoff) {
      const at = now();
      if (lastPortSettingsSentAt !== undefined && at - lastPortSettingsSentAt < OPEN_PORT_SETTINGS_MIN_INTERVAL_MS)
        return;
      lastPortSettingsSentAt = at;
      // Sanitized again here so nothing outside the whitelist ever reaches the App, whatever the caller passed.
      try {
        options.onOpenPortSettings?.({
          preferences: sanitizeBrowserPreferences(handoff.preferences),
          route: sanitizeHandoffRoute(handoff.route),
        });
      } catch {
        // The App not being reachable must not turn the click into a server error.
      }
    },
  };
}
