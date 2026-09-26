import { storeToRefs } from "pinia";
import { useSessionsStore } from "../stores/sessions";

/** Transitional adapter exposing Session detail state and navigation from the Sessions store. */
export function useSessionDetail() {
  const store = useSessionsStore();
  const { selectedDetail, position } = storeToRefs(store);

  return {
    selectedDetail,
    position,
    openSessionDetail: store.openSessionDetail,
    closeSessionDetail: store.closeSessionDetail,
    setSessionSequence: store.setSessionSequence,
    openAdjacentSession: store.openAdjacentSession,
  };
}
