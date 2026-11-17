/**
 * What the first-run page remembers between its renders. The page is rebuilt every few seconds while it polls main, and
 * a control the user already touched (a ticked migration consent, the opened 「進階」) must come back the way it was.
 */
export interface SetupMemory {
  /** Whether the migration consent of this source is ticked. */
  consent(sourceId: string): boolean;
  setConsent(sourceId: string, checked: boolean): void;
  /** Drops the consent of sources that are no longer listed. */
  keepConsentFor(sourceIds: readonly string[]): void;
  advancedOpen(): boolean;
  setAdvancedOpen(open: boolean): void;
}

export function createSetupMemory(): SetupMemory {
  const consents = new Map<string, boolean>();
  let advanced = false;
  return {
    consent: (sourceId) => consents.get(sourceId) === true,
    setConsent: (sourceId, checked) => {
      consents.set(sourceId, checked);
    },
    keepConsentFor: (sourceIds) => {
      for (const id of [...consents.keys()]) if (!sourceIds.includes(id)) consents.delete(id);
    },
    advancedOpen: () => advanced,
    setAdvancedOpen: (open) => {
      advanced = open;
    },
  };
}
