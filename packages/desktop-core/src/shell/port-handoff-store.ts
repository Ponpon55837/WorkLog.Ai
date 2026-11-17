import {
  encodePortHandoffFragment,
  sanitizeBrowserPreferences,
  sanitizeHandoffRoute,
  type PortHandoff,
} from "@work-intelligence/schema";

/** How long the page's preferences wait for the user to finish the change. */
export const PORT_HANDOFF_TTL_MS = 2 * 60 * 1000;

/**
 * The page's whitelisted preferences and route, kept in main-process memory only for one port change: single use, and
 * gone after {@link PORT_HANDOFF_TTL_MS}. It is never written to disk or to a log.
 */
export class PortHandoffStore {
  private readonly clock: () => number;
  private held: { readonly handoff: PortHandoff; readonly expiresAt: number } | undefined;

  constructor(clock: () => number) {
    this.clock = clock;
  }

  /** Sanitizes again and replaces any earlier snapshot. */
  put(preferences: unknown, route: unknown): void {
    this.held = {
      handoff: { preferences: sanitizeBrowserPreferences(preferences), route: sanitizeHandoffRoute(route) },
      expiresAt: this.clock() + PORT_HANDOFF_TTL_MS,
    };
  }

  /** Whether a fresh snapshot waits (without consuming it). */
  holds(): boolean {
    return this.held !== undefined && this.clock() < this.held.expiresAt;
  }

  /** The snapshot once, or undefined when there is none or it expired. */
  take(): PortHandoff | undefined {
    const { held } = this;
    this.held = undefined;
    return held !== undefined && this.clock() < held.expiresAt ? held.handoff : undefined;
  }
}

/** The address the Dashboard opens at: the plain root, or the root with the handoff fragment. Nothing else is built. */
export function dashboardUrlFor(port: number, handoff?: PortHandoff): string {
  const base = `http://127.0.0.1:${port}/`;
  return handoff ? `${base}#${encodePortHandoffFragment(handoff)}` : base;
}
