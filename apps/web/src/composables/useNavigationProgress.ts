import { onBeforeUnmount, ref, type Ref } from "vue";
import { useRouter } from "vue-router";

export function useNavigationProgress(): Ref<boolean> {
  const router = useRouter();
  const navigating = ref(false);
  const removeBefore = router.beforeEach((to, from) => {
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
