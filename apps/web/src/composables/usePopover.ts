import { nextTick, onBeforeUnmount, ref, watch, type Ref } from "vue";

type Align = "start" | "end";

/**
 * Floating panel anchored to a trigger. The panel is teleported to <body> and positioned with
 * `position: fixed`, so it is never clipped by an `overflow: hidden` Box.
 */
export function usePopover(options: { align?: Ref<Align> | Align; width?: number } = {}) {
  const open = ref(false);
  const trigger = ref<HTMLElement | null>(null);
  const panel = ref<HTMLElement | null>(null);
  const style = ref<Record<string, string>>({});
  const gutter = 8;

  function align(): Align {
    const value = options.align;
    return typeof value === "string" ? value : value?.value ?? "start";
  }

  function position(): void {
    const anchor = trigger.value?.getBoundingClientRect();
    if (!anchor) {
      return;
    }
    const width = Math.min(options.width ?? panel.value?.offsetWidth ?? 260, window.innerWidth - gutter * 2);
    const height = panel.value?.offsetHeight ?? 0;
    const preferredLeft = align() === "end" ? anchor.right - width : anchor.left;
    const left = Math.min(Math.max(gutter, preferredLeft), window.innerWidth - width - gutter);
    const below = anchor.bottom + 4;
    const top = below + height > window.innerHeight - gutter && anchor.top - height - 4 > gutter ? anchor.top - height - 4 : below;
    style.value = { left: `${left}px`, top: `${top}px`, width: `${width}px` };
  }

  function handlePointer(event: PointerEvent): void {
    const target = event.target as Node;
    if (!panel.value?.contains(target) && !trigger.value?.contains(target)) {
      close();
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      close();
      trigger.value?.focus();
    }
  }

  function listen(active: boolean): void {
    if (active) {
      document.addEventListener("pointerdown", handlePointer, true);
      document.addEventListener("keydown", handleKeydown);
      window.addEventListener("resize", position);
      window.addEventListener("scroll", position, true);
    } else {
      document.removeEventListener("pointerdown", handlePointer, true);
      document.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    }
  }

  function toggle(): void {
    open.value = !open.value;
  }

  function close(): void {
    open.value = false;
  }

  watch(open, async (value) => {
    listen(value);
    if (value) {
      await nextTick();
      position();
      await nextTick();
      position();
    }
  });

  onBeforeUnmount(() => listen(false));

  return { open, trigger, panel, style, toggle, close, position };
}
