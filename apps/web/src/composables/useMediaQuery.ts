import { onBeforeUnmount, ref, type Ref } from "vue";

/** Whether a CSS media query matches, kept in sync while the component is mounted. */
export function useMediaQuery(query: string): Ref<boolean> {
  const list = typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query) : undefined;
  const matches = ref(list?.matches ?? false);

  function update(event: MediaQueryListEvent): void {
    matches.value = event.matches;
  }

  list?.addEventListener("change", update);
  onBeforeUnmount(() => list?.removeEventListener("change", update));
  return matches;
}
