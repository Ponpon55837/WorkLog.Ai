/**
 * Keeping the keyboard where it was when a panel is drawn again. The poll replaces the panel's content; a control the user
 * was on is found again by its `data-id` (or `id`), with the caret of a text box, so typing and tabbing are not lost.
 */
export interface FocusSnapshot {
  readonly selector: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
}

/** What is focused inside `root` (null when the focus is elsewhere: nothing to restore, and nothing to steal). */
export function captureFocus(root: HTMLElement): FocusSnapshot | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === root || !root.contains(active)) return null;
  const id = active.dataset.id;
  const selector = id ? `[data-id="${CSS.escape(id)}"]` : active.id ? `#${CSS.escape(active.id)}` : null;
  if (selector === null) return null;
  const text = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
  return {
    selector,
    selectionStart: text?.selectionStart ?? null,
    selectionEnd: text?.selectionEnd ?? null,
  };
}

/** Puts the focus back; when that control is gone (or cannot take focus now) the panel itself holds it, so Tab continues from there. */
export function restoreSnapshot(root: HTMLElement, snapshot: FocusSnapshot | null): void {
  if (snapshot === null) return;
  const target = root.querySelector<HTMLElement>(snapshot.selector);
  target?.focus();
  if (target === null || document.activeElement !== target) {
    root.focus();
    return;
  }
  if (
    snapshot.selectionStart !== null &&
    (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
  ) {
    try {
      target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
    } catch {
      // Some input types have no selection; the focus is what matters.
    }
  }
}
