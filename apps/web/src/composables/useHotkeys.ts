import { onBeforeUnmount, onMounted } from "vue";
import { navItems } from "../components/layout/navigation";
import { router } from "../router";

const sequenceTimeoutMs = 1_000;

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest("input, textarea, select, [contenteditable='true']"));
}

/**
 * Global shortcuts: Ctrl/⌘ K opens the palette, "/" focuses the page search,
 * "g" + letter jumps to a page (see navigation.ts). Ignored while typing.
 */
export function useHotkeys(options: { openPalette: () => void }): void {
  let pendingG = false;
  let timer: number | undefined;

  function onKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      options.openPalette();
      return;
    }
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      isTyping(event.target) ||
      document.body.classList.contains("modal-open")
    ) {
      return;
    }
    if (event.key === "/") {
      const search = document.querySelector<HTMLInputElement>("main input[type='search']");
      if (search) {
        event.preventDefault();
        search.focus();
      }
      return;
    }
    if (pendingG) {
      pendingG = false;
      window.clearTimeout(timer);
      const target = navItems.find((item) => item.shortcut === `g ${event.key.toLowerCase()}`);
      if (target) {
        event.preventDefault();
        void router.push({ name: target.name });
      }
      return;
    }
    if (event.key === "g") {
      pendingG = true;
      timer = window.setTimeout(() => (pendingG = false), sequenceTimeoutMs);
    }
  }

  onMounted(() => window.addEventListener("keydown", onKeydown));
  onBeforeUnmount(() => {
    window.removeEventListener("keydown", onKeydown);
    window.clearTimeout(timer);
  });
}
