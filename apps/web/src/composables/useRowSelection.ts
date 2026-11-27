import { computed, ref } from "vue";

type RowSelectionOptions = { onClear?: () => void };

/** Checkbox selection over the rows that can currently be acted on. */
export function useRowSelection(eligibleIds: () => string[], options: RowSelectionOptions = {}) {
  const selectedIds = ref<string[]>([]);

  const allSelected = computed({
    get: () => eligibleIds().length > 0 && eligibleIds().every((id) => selectedIds.value.includes(id)),
    set: (selected: boolean) => {
      if (selected) selectedIds.value = eligibleIds();
      else clearSelection();
    },
  });

  function clearSelection(): void {
    options.onClear?.();
    selectedIds.value = [];
  }

  function selectItem(id: string, selected: boolean): void {
    selectedIds.value = selected ? [...new Set([...selectedIds.value, id])] : selectedIds.value.filter((x) => x !== id);
  }

  /** Ids that were applied or skipped are done with; anything else stays selected so it can be retried. */
  function dropFromSelection(ids: string[]): void {
    const dropped = new Set(ids);
    selectedIds.value = selectedIds.value.filter((id) => !dropped.has(id));
    if (selectedIds.value.length === 0) clearSelection();
  }

  return { selectedIds, allSelected, clearSelection, selectItem, dropFromSelection };
}
