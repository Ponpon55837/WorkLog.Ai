import { nextTick, ref, type ComponentPublicInstance } from "vue";

type FocusRestoreOptions = { rowIdAttribute: string; actionSelector: string };

/** An action removes its row once the list refetches, so focus would fall to the page; keep it in the list instead. */
export function useFocusRestore(options: FocusRestoreOptions) {
  const boxRef = ref<ComponentPublicInstance | null>(null);
  const listRef = ref<ComponentPublicInstance | null>(null);
  let pending: { nextItemId?: string } | undefined;
  const rowSelector = `[${options.rowIdAttribute}]`;
  const datasetKey = options.rowIdAttribute
    .replace(/^data-/, "")
    .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

  /** Focus on the page, or on a toast that is leaving, counts as lost. */
  function focusIsLost(): boolean {
    const active = document.activeElement;
    return !active || active === document.body || Boolean(active.closest(".ui-toast-host"));
  }

  function focusIfLost(): void {
    if (!pending || !focusIsLost()) return;
    const { nextItemId } = pending;
    pending = undefined;
    const root = listRef.value?.$el as HTMLElement | undefined;
    if (!root) {
      const box = boxRef.value?.$el as HTMLElement | undefined;
      box?.querySelector<HTMLElement>(".ui-empty button, .ui-flash button")?.focus();
      return;
    }
    const rows = [...root.querySelectorAll<HTMLElement>(rowSelector)];
    const row = rows.find((element) => element.dataset[datasetKey] === nextItemId) ?? rows[0];
    const action = row?.querySelector<HTMLElement>(`${options.actionSelector}:not(:disabled)`);
    if (action) return action.focus();
    if (!root.hasAttribute("tabindex")) root.tabIndex = -1;
    root.focus();
  }

  async function restoreFocus(nextItemId?: string): Promise<void> {
    pending = { nextItemId };
    await nextTick();
    focusIfLost();
  }

  function settleFocus(): void {
    focusIfLost();
    pending = undefined;
  }

  return { boxRef, listRef, restoreFocus, settleFocus };
}
