import { defineStore } from "pinia";
import { ref } from "vue";
import type { SessionLinkDirection, WorkSessionRecord } from "@work-intelligence/core";

/** The "link Sessions" dialog: the source Session, the search, and the chosen target and relation. */
export const useSessionLinkDialogStore = defineStore("session-link-dialog", () => {
  const linkSource = ref<WorkSessionRecord | null>(null);
  const linkQuery = ref("");
  const linkTargetId = ref("");
  const linkDirection = ref<SessionLinkDirection>("continues");
  const linkSaving = ref(false);
  const linkActionError = ref("");

  function $reset(): void {
    linkSource.value = null;
    linkQuery.value = "";
    linkTargetId.value = "";
    linkDirection.value = "continues";
    linkSaving.value = false;
    linkActionError.value = "";
  }

  return { linkSource, linkQuery, linkTargetId, linkDirection, linkSaving, linkActionError, $reset };
});
