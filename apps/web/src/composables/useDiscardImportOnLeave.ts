import { onBeforeMount, onBeforeUnmount } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { useProjectDataTransferStore } from "../stores/project-data-transfer";

/**
 * Removes the staged import file on the API when the user really leaves the page that chose it: on route leave and on
 * `pagehide` (the last with a keepalive request, which the browser completes after the page is gone). Unmounting alone
 * does not discard: a language switch remounts the page (it is keyed by locale) and the preview must survive it. A
 * staged file that nobody removes still expires on its own after 30 minutes.
 */
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
