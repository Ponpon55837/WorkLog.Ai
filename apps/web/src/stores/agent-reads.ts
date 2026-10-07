import { computed, ref, watch } from "vue";
import { useQuery } from "@pinia/colada";
import { defineStore, storeToRefs } from "pinia";
import type { AgentReadAuditPage, AgentReadReferences } from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { errorMessage } from "../utils/format";
import type { ListPageSize } from "../utils/labels";
import { queryKeys } from "./query-keys";
import { useSessionsStore } from "./sessions";
import { t } from "../i18n";

/** The audit API caps a page at 100 rows, so "all" asks for the largest page. */
function auditPageSize(value: ListPageSize): number {
  return value === "all" ? 100 : value;
}

/** Owns the passive Agent read audit: the system-status list and the per-Session read history. */
export const useAgentReadsStore = defineStore("agent-reads", () => {
  const { selectedDetail } = storeToRefs(useSessionsStore());
  const listActive = ref(false);
  const projectId = ref("");
  const agent = ref("");
  const page = ref(1);
  const pageSize = ref<ListPageSize>(10);

  const listQuery = useQuery<AgentReadAuditPage>({
    key: () => [
      ...queryKeys.agentReads.list,
      { projectId: projectId.value, agent: agent.value, page: page.value, pageSize: pageSize.value },
    ],
    enabled: listActive,
    placeholderData: (previousData) => previousData,
    query: ({ signal }) =>
      useApi().client.listAgentReads(
        {
          projectId: projectId.value || undefined,
          agent: agent.value || undefined,
          page: page.value,
          pageSize: auditPageSize(pageSize.value),
        },
        signal,
      ),
  });
  const selectedSessionId = computed(() => selectedDetail.value?.session.id);
  const sessionReadsQuery = useQuery<AgentReadReferences>({
    key: () => [...queryKeys.agentReads.session, selectedSessionId.value ?? null],
    enabled: computed(() => selectedSessionId.value !== undefined),
    query: ({ signal }) => {
      const sessionId = selectedSessionId.value;
      if (!sessionId) throw new Error("A Session must be selected before loading its Agent reads.");
      return useApi().client.getSessionAgentReads(sessionId, signal);
    },
  });

  const reads = computed(() => listQuery.data.value?.items ?? []);
  const pageInfo = computed(() => listQuery.data.value?.pageInfo);
  const agentOptions = computed(() => listQuery.data.value?.agents ?? []);
  const loaded = computed(() => listQuery.data.value !== undefined);
  const error = computed(() =>
    listQuery.error.value ? errorMessage(listQuery.error.value, t("systemStatus.agentReadsCouldNotLoad")) : "",
  );
  const sessionReads = computed(() => sessionReadsQuery.data.value);

  // A filter change returns to page 1, unless the page changed with it (a deep link or back/forward restoring the URL).
  watch([projectId, agent, pageSize, page], ([, , , nextPage], [, , , previousPage]) => {
    if (nextPage === previousPage) page.value = 1;
  });

  function setListActive(active: boolean): void {
    listActive.value = active;
  }

  async function reload(): Promise<void> {
    try {
      await listQuery.refetch(true);
    } catch {
      // Query errors are exposed through `error` for the box to render.
    }
  }

  return {
    projectId,
    agent,
    page,
    pageSize,
    reads,
    pageInfo,
    agentOptions,
    loaded,
    error,
    sessionReads,
    setListActive,
    reload,
  };
});
