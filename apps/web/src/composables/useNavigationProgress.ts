import { onBeforeUnmount, ref, type Ref } from "vue";
import { useRouter } from "vue-router";

/** True while the router resolves a navigation (lazy page chunks, guards), for the shell's progress bar. */
export function useNavigationProgress(): Ref<boolean> {
  const router = useRouter();
  const navigating = ref(false);
  const removeBefore = router.beforeEach((to, from) => {
    // Query-only changes (filters, pagination, ?session) never load anything new.
    if (to.path !== from.path) navigating.value = true;
  });
  const removeAfter = router.afterEach(() => (navigating.value = false));
  const removeError = router.onError(() => (navigating.value = false));

  onBeforeUnmount(() => {
    removeBefore();
    removeAfter();
    removeError();
  });

  return navigating;
}
