import { storeToRefs } from "pinia";
import { emptyPageInfo, useSessionsStore } from "../stores/sessions";

export { emptyPageInfo };

/** Transitional adapter exposing the Sessions store to existing view and import consumers. */
export function useSessions() {
  const store = useSessionsStore();
  const {
    sessions,
    sessionsLoading,
    sessionsLoaded,
    searchTerm,
    selectedProjectId,
    sessionPage,
    sessionPageSize,
    sessionPageInfo,
    dateFrom,
    dateTo,
    voidedFilter,
    sessionFilterError,
    hasSessionFilters,
  } = storeToRefs(store);

  return {
    sessions,
    sessionsLoading,
    sessionsLoaded,
    searchTerm,
    selectedProjectId,
    sessionPage,
    sessionPageSize,
    sessionPageInfo,
    dateFrom,
    dateTo,
    voidedFilter,
    sessionFilterError,
    hasSessionFilters,
    setSessionsListActive: store.setSessionsListActive,
    loadSessions: store.loadSessions,
    clearSessionFilters: store.clearSessionFilters,
  };
}
