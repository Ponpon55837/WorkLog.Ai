import type { FilterChip } from "../components/ui/types";
import { t } from "../i18n";

/** A removable chip that reads "label: value". */
export function filterChip(key: string, label: string, value: string): FilterChip {
  return { key, label: t("ui.filterValue", { label, value }) };
}
