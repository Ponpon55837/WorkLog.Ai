export interface FocusSnapshot {
  readonly selector: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
}

const lastFocused = new WeakMap<HTMLElement, FocusSnapshot>();

export function forgetFocus(root: HTMLElement): void {
  lastFocused.delete(root);
}

export function captureFocus(root: HTMLElement): FocusSnapshot | null {
  const active = document.activeElement;
  // A guarded action redraws with the pressed button disabled, so focus fell to the root.
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
      // Some input types have no selection.
    }
  }
}
