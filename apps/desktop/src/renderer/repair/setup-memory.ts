export interface SetupMemory {
  consent(sourceId: string): boolean;
  setConsent(sourceId: string, checked: boolean): void;
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
