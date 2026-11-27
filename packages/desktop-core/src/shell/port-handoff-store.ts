import {
  encodePortHandoffFragment,
  sanitizeBrowserPreferences,
  sanitizeHandoffRoute,
  type PortHandoff,
} from "@work-intelligence/schema";

export const PORT_HANDOFF_TTL_MS = 2 * 60 * 1000;

export class PortHandoffStore {
  private readonly clock: () => number;
  private held: { readonly handoff: PortHandoff; readonly expiresAt: number } | undefined;

  constructor(clock: () => number) {
    this.clock = clock;
  }

  put(preferences: unknown, route: unknown): void {
    this.held = {
      handoff: { preferences: sanitizeBrowserPreferences(preferences), route: sanitizeHandoffRoute(route) },
      expiresAt: this.clock() + PORT_HANDOFF_TTL_MS,
    };
  }

  holds(): boolean {
    return this.held !== undefined && this.clock() < this.held.expiresAt;
  }

  take(): PortHandoff | undefined {
    const { held } = this;
    this.held = undefined;
    return held !== undefined && this.clock() < held.expiresAt ? held.handoff : undefined;
  }
}

export function dashboardUrlFor(port: number, handoff?: PortHandoff): string {
  const base = `http://127.0.0.1:${port}/`;
  return handoff ? `${base}#${encodePortHandoffFragment(handoff)}` : base;
}
