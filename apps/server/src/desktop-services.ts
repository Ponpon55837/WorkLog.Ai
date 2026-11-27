import type { SystemDesktopStatus } from "@work-intelligence/core";
import {
  sanitizeBrowserPreferences,
  sanitizeHandoffRoute,
  type BrowserPreferences,
  type DesktopFacts,
} from "@work-intelligence/schema";
import type { DesktopRouteServices, ShellLocale } from "./routes/router.js";

export interface DesktopHandlerOptions {
  facts?: DesktopFacts;
  getFacts?: () => DesktopFacts | undefined;
  onOpenAgentSetup: () => void;
  onOpenPortSettings?: (handoff: { preferences: BrowserPreferences; route: string }) => void;
  onSetLanguage?: (locale: ShellLocale) => void;
  now?: () => number;
}

/** @internal test-only */
export const OPEN_AGENT_SETUP_MIN_INTERVAL_MS = 1000;

/** @internal test-only */
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
      ...(facts?.language ? { language: facts.language } : {}),
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
      // Sanitized again so nothing outside the whitelist reaches the App, whatever the caller passed.
      try {
        options.onOpenPortSettings?.({
          preferences: sanitizeBrowserPreferences(handoff.preferences),
          route: sanitizeHandoffRoute(handoff.route),
        });
      } catch {
        // The App not being reachable must not turn the click into a server error.
      }
    },
    requestSetLanguage(locale) {
      try {
        options.onSetLanguage?.(locale);
      } catch {
        // The App not being reachable must not turn the language change into a server error.
      }
    },
  };
}
