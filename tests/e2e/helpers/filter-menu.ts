import type { Locator, Page } from "@playwright/test";

/** The filter menu trigger of a label; once a value is applied its text reads "label：value", and the chip remove button must not match. */
export function filterMenu(scope: Page | Locator, label: string): Locator {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return scope.locator('button[aria-haspopup="menu"]').filter({ hasText: new RegExp(`^${escaped}(?:[:：].+)?$`) });
}
