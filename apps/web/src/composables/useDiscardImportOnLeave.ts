import { onBeforeMount, onBeforeUnmount } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { useProjectDataTransferStore } from "../stores/project-data-transfer";

/** Unmounting alone does not discard: a language switch remounts the page (keyed by locale) and the preview must survive it. Staged files expire after 30 minutes. */
export function useDiscardImportOnLeave(): void {
  const transferStore = useProjectDataTransferStore();

  function onPageHide(): void {
    transferStore.discardImportFile(true);
  }

  onBeforeRouteLeave(() => {
    transferStore.discardImportFile();
  });

  onBeforeMount(() => window.addEventListener("pagehide", onPageHide));
  onBeforeUnmount(() => window.removeEventListener("pagehide", onPageHide));
}
