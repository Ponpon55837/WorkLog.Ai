/**
 * Keeping the keyboard where it was when a panel is drawn again. The poll replaces the panel's content; a control the user
 * was on is found again by its `data-id` (or `id`), with the caret of a text box, so typing and tabbing are not lost.
 */
export interface FocusSnapshot {
  readonly selector: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
}

/**
 * The control each root last had the keyboard on. A guarded action redraws with the pressed button disabled, so the
 * focus falls to the root; the next capture answers with this control, and it gets the focus back once it is enabled.
 */
const lastFocused = new WeakMap<HTMLElement, FocusSnapshot>();

/** Drops what a root remembers (the user left it for another place on purpose). */
export function forgetFocus(root: HTMLElement): void {
  lastFocused.delete(root);
}

/** What is focused inside `root` (null when the focus is elsewhere: nothing to restore, and nothing to steal). */
export function captureFocus(root: HTMLElement): FocusSnapshot | null {
  const active = document.activeElement;
  // The root itself holds the focus: the control the user was on could not take it back yet (it was disabled).
  if (active === root) return lastFocused.get(root) ?? null;
  if (!(active instanceof HTMLElement) || !root.contains(active)) {
    lastFocused.delete(root);
    return null;
  }
  const id = active.dataset.id;
  const selector = id ? `[data-id="${CSS.escape(id)}"]` : active.id ? `#${CSS.escape(active.id)}` : null;
  if (selector === null) {
    lastFocused.delete(root);
    return null;
  }
  const text = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
  const snapshot = {
    selector,
    selectionStart: text?.selectionStart ?? null,
    selectionEnd: text?.selectionEnd ?? null,
  };
  lastFocused.set(root, snapshot);
  return snapshot;
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
