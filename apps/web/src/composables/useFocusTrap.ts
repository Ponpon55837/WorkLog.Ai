import { nextTick, onBeforeUnmount, watch, type Ref } from "vue";

const focusableSelector = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled):not([type='hidden'])",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

let scrollLocks = 0;

function lockScroll(lock: boolean): void {
  scrollLocks = Math.max(0, scrollLocks + (lock ? 1 : -1));
  document.body.classList.toggle("modal-open", scrollLocks > 0);
}

/**
 * Overlay a11y contract shared by UiDialog and UiSidePanel: moves focus into the container,
 * keeps Tab inside it, closes on Escape, locks page scroll and restores focus on close.
 */
export function useFocusTrap(
  container: Ref<HTMLElement | null>,
  active: Ref<boolean>,
  options: { onEscape: () => void; lockScroll?: boolean; trapTab?: boolean }
): void {
  let previousFocus: HTMLElement | null = null;
  let locked = false;

  function focusables(): HTMLElement[] {
    return Array.from(container.value?.querySelectorAll<HTMLElement>(focusableSelector) ?? []).filter(
      (element) => element.getClientRects().length > 0
    );
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      options.onEscape();
      return;
    }
    if (event.key !== "Tab" || options.trapTab === false) {
      return;
    }
    const items = focusables();
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function setLocked(value: boolean): void {
    if (options.lockScroll === false || locked === value) {
      return;
    }
    locked = value;
    lockScroll(value);
  }

  async function activate(): Promise<void> {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setLocked(true);
    await nextTick();
    const element = container.value;
    element?.addEventListener("keydown", handleKeydown);
    const autofocus = element?.querySelector<HTMLElement>("[autofocus]");
    (autofocus ?? focusables()[0] ?? element)?.focus();
  }

  function deactivate(): void {
    container.value?.removeEventListener("keydown", handleKeydown);
    setLocked(false);
    if (previousFocus?.isConnected) {
      previousFocus.focus();
    }
    previousFocus = null;
  }

  watch(active, (value) => {
    if (value) {
      void activate();
    } else {
      deactivate();
    }
  }, { immediate: true });

  onBeforeUnmount(deactivate);
}
