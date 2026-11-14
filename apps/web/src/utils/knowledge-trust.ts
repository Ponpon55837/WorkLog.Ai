export type TrustCell = "confirmed" | "contradicted";

/** The most cells one trust bar draws; larger counts are scaled down to fit. */
const MAX_TRUST_CELLS = 12;

/**
 * One cell per confirmation (confirmed) or contradiction (contradicted). Past `max` cells the two counts are
 * scaled to fit, each keeping at least one cell while it is above zero. The exact numbers are always shown as text.
 */
export function trustCells(confirmed: number, contradicted: number, max = MAX_TRUST_CELLS): TrustCell[] {
  const total = confirmed + contradicted;
  if (total <= 0) return [];
  let confirmedCells = confirmed;
  let contradictedCells = contradicted;
  if (total > max) {
    contradictedCells = contradicted > 0 ? Math.max(1, Math.round((contradicted / total) * max)) : 0;
    confirmedCells = confirmed > 0 ? Math.max(1, max - contradictedCells) : 0;
    contradictedCells = Math.min(contradictedCells, max - confirmedCells);
  }
  return [
    ...Array.from({ length: confirmedCells }, (): TrustCell => "confirmed"),
    ...Array.from({ length: contradictedCells }, (): TrustCell => "contradicted"),
  ];
}
