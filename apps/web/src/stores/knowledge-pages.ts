import { useMutation, useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type {
  KnowledgePageListResult,
  KnowledgePageVersionsResult,
  RequestKnowledgePageUpdateInput,
  UpdateKnowledgePageInput,
} from "@work-intelligence/core";
import { useApi } from "../composables/useApi";
import { errorMessage } from "../utils/format";
import { queryKeys } from "./query-keys";
import { t } from "../i18n";

/** Owns the standing Knowledge pages of the Knowledge page: the list, the open page, and its version history. */
export const useKnowledgePagesStore = defineStore("knowledge-pages", () => {
  const queryCache = useQueryCache();

  const listEnabled = ref(false);
  const projectRoot = ref<string | undefined>();
  const openPageId = ref<string | null>(null);

  const listQuery = useQuery<KnowledgePageListResult>({
    key: () => [...queryKeys.knowledge.pages, projectRoot.value ?? ""],
    enabled: listEnabled,
    query: ({ signal }) => useApi().client.listKnowledgePages(projectRoot.value, signal),
  });
  const versionsQuery = useQuery<KnowledgePageVersionsResult>({
    key: () => [...queryKeys.knowledge.pageVersions, openPageId.value ?? ""],
    enabled: () => Boolean(openPageId.value),
    query: ({ signal }) => useApi().client.listKnowledgePageVersions(openPageId.value!, signal),
  });

  const pages = computed(() => (listQuery.data.value?.outcome === "knowledge_pages" ? listQuery.data.value.items : []));
  const pagesLoading = computed(() => listQuery.isLoading.value);
  const pagesLoaded = computed(() => listQuery.data.value !== undefined);
  const pagesError = computed(() => {
    if (listQuery.error.value) return errorMessage(listQuery.error.value, t("knowledge.couldNotLoadKnowledgePages"));
    const result = listQuery.data.value;
    return result?.outcome === "skipped" ? (result.reason ?? t("common.trackingIsNotEnabledFor")) : "";
  });
  const newDataCount = computed(() => pages.value.filter((page) => page.status === "has_new_data").length);
  const openPage = computed(() => {
    const result = versionsQuery.data.value;
    const fromVersions = result?.outcome === "knowledge_page_versions" ? result.page : undefined;
    return pages.value.find((page) => page.id === openPageId.value) ?? fromVersions ?? null;
  });
  const versions = computed(() =>
    versionsQuery.data.value?.outcome === "knowledge_page_versions" ? versionsQuery.data.value.versions : [],
  );
  const sources = computed(() =>
    versionsQuery.data.value?.outcome === "knowledge_page_versions" ? versionsQuery.data.value.sources : [],
  );
  const versionsLoading = computed(() => versionsQuery.isLoading.value);
  const versionsError = computed(() =>
    versionsQuery.error.value ? errorMessage(versionsQuery.error.value, t("knowledge.couldNotLoadKnowledgePage")) : "",
  );

  async function invalidatePages(): Promise<void> {
    // A superseded background refresh must not report a committed save as failed.
    await Promise.allSettled([
      queryCache.invalidateQueries({ key: queryKeys.attention.list }),
      queryCache.invalidateQueries({ key: queryKeys.knowledge.pages }),
      queryCache.invalidateQueries({ key: queryKeys.knowledge.pageVersions }),
    ]);
  }

  const requestMutation = useMutation({
    mutation: (input: RequestKnowledgePageUpdateInput) => useApi().client.requestKnowledgePageUpdate(input),
    onSuccess: invalidatePages,
  });
  const updateMutation = useMutation({
    mutation: (input: UpdateKnowledgePageInput) => useApi().client.updateKnowledgePage(input),
    onSuccess: invalidatePages,
  });

  function setListActive(active: boolean, root?: string): void {
    listEnabled.value = active;
    projectRoot.value = root;
  }

  async function reload(): Promise<void> {
    await listQuery.refetch(true);
  }

  function showPage(pageId: string): void {
    openPageId.value = pageId;
  }

  function closePage(): void {
    openPageId.value = null;
  }

  function requestUpdate(input: RequestKnowledgePageUpdateInput) {
    return requestMutation.mutateAsync(input);
  }

  function updatePage(input: UpdateKnowledgePageInput) {
    return updateMutation.mutateAsync(input);
  }

  return {
    listEnabled,
    openPageId,
    pages,
    pagesLoading,
    pagesLoaded,
    pagesError,
    newDataCount,
    openPage,
    versions,
    sources,
    versionsLoading,
    versionsError,
    setListActive,
    reload,
    showPage,
    closePage,
    requestUpdate,
    updatePage,
  };
});
