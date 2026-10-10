<script setup lang="ts">
import { useRoute } from "vue-router";
import { computed, onBeforeUnmount, onMounted, watch } from "vue";
import { storeToRefs } from "pinia";
import { ArrowRight, CircleCheckBig, Filter, FolderGit2 } from "lucide-vue-next";
import { ATTENTION_KINDS } from "@work-intelligence/core";
import UiActionMenu from "../ui/UiActionMenu.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiCounter from "../ui/UiCounter.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiPagination from "../ui/UiPagination.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import VirtualList from "../VirtualList.vue";
import { enumQuery, pageQuery, stringQuery, useRouteQuery } from "../../composables/useRouteQuery";
import { useAttentionStore } from "../../stores/attention";
import { useProjectsStore } from "../../stores/projects";
import { attentionKindKeys, attentionReasonKeys, attentionRoute } from "../../utils/attention";
import type { ListPageSize } from "../../utils/labels";
import { formatRelative } from "../../utils/format";
import { t } from "../../i18n";

/** Dashboard attention pointers with explicit coverage and domain-owned actions. */
const route = useRoute();
const store = useAttentionStore();
const { projectId, kind, page, pageSize, result, items, groups, loaded, loading, error, skipped, hasIncomplete } =
  storeToRefs(store);
const { projects } = storeToRefs(useProjectsStore());
useRouteQuery("attentionProject", projectId, stringQuery());
useRouteQuery("attentionKind", kind, enumQuery(["", ...ATTENTION_KINDS], ""));
useRouteQuery("attentionPage", page, pageQuery());
useRouteQuery("attentionSize", pageSize, enumQuery<ListPageSize>([10, 20, 50], 20));

const projectNames = computed(() => new Map(projects.value.map((project) => [project.id, project.name])));
const projectItems = computed(() => [
  { value: "", label: t("common.allTrackedProjects") },
  ...projects.value
    .filter((project) => project.status === "tracked")
    .map((project) => ({ value: project.id, label: project.name })),
]);
const kindItems = computed(() => [
  { value: "" as const, label: t("common.allKinds") },
  ...ATTENTION_KINDS.map((value) => ({ value, label: t(attentionKindKeys[value]) })),
]);
const countLabel = computed(() =>
  result.value?.total === null
    ? t("attention.atLeast", { count: result.value.minimumTotal })
    : String(result.value?.total ?? ""),
);
const warnings = computed(() =>
  groups.value
    .filter((group) => group.state !== "complete")
    .map((group) =>
      group.state === "failed"
        ? t("attention.sourceFailed", { source: t(attentionKindKeys[group.kind]) })
        : t("attention.sourcePartial", {
            source: t(attentionKindKeys[group.kind]),
            examined: group.examined,
            available: group.available,
          }),
    ),
);
const rows = computed(() =>
  items.value.map((item) => ({
    ...item,
    displayTitle: item.title || t(attentionKindKeys[item.kind]),
    meta: t("attention.rowMeta", {
      source: t(attentionKindKeys[item.kind]),
      project: item.projectName || projectNames.value.get(item.projectId ?? "") || t("common.allTrackedProjects"),
      updated: formatRelative(item.updatedAt),
      count: item.count ?? 1,
    }),
    reasonLabel: t(attentionReasonKeys[item.reason]),
    to: attentionRoute(item),
  })),
);
const sizeOptions: readonly { value: ListPageSize; label: string }[] = [
  { value: 10, label: "10" },
  { value: 20, label: "20" },
  { value: 50, label: "50" },
];

watch([projectId, kind, pageSize], () => {
  // Back/forward restores the complete URL, while a user filter change starts at page one.
  if (
    (route.query.attentionProject ?? "") !== projectId.value ||
    (route.query.attentionKind ?? "") !== kind.value ||
    Number(route.query.attentionSize ?? 20) !== Number(pageSize.value)
  )
    page.value = 1;
});
onMounted(() => store.setActive(true));
onBeforeUnmount(() => store.setActive(false));
</script>

<template>
  <UiBox data-testid="attention-box">
    <template #header>
      <UiBoxTitle eyebrow="Action required" :title="t('dashboard.needsAttention')" />
      <UiCounter v-if="loaded && result?.minimumTotal" :count="countLabel" tone="attention" />
      <div class="attention__filters">
        <UiActionMenu
          v-model="projectId"
          :label="t('common.project')"
          :items="projectItems"
          :icon="FolderGit2"
          default-value=""
          size="sm"
        />
        <UiActionMenu
          v-model="kind"
          :label="t('common.kind')"
          :items="kindItems"
          :icon="Filter"
          default-value=""
          size="sm"
        />
      </div>
    </template>
    <UiFlash v-if="error" tone="danger"
      >{{ error
      }}<template #actions
        ><UiButton size="sm" :loading="loading" @click="store.reload()">{{ t("common.retry") }}</UiButton></template
      ></UiFlash
    >
    <UiFlash v-for="warning in warnings" :key="warning" tone="attention"
      >{{ warning
      }}<template #actions
        ><UiButton size="sm" :loading="loading" @click="store.reload()">{{ t("common.retry") }}</UiButton></template
      ></UiFlash
    >
    <UiSkeleton v-if="!loaded && !error" variant="text" :count="3" :label="t('attention.loading')" />
    <UiEmptyState
      v-else-if="skipped"
      compact
      :title="t('common.trackingIsNotEnabledFor')"
      :description="t('attention.scopeSkipped')"
    />
    <UiEmptyState
      v-else-if="loaded && !rows.length"
      compact
      :icon="hasIncomplete ? undefined : CircleCheckBig"
      :title="hasIncomplete ? t('attention.unknownEmpty') : t('attention.empty')"
      :description="t('attention.emptyDescription')"
    />
    <VirtualList
      v-else-if="rows.length"
      :items="rows"
      :item-key="(item) => item.id"
      :enabled="true"
      max-height="420px"
      :estimate-item-height="96"
      :label="t('attention.list')"
    >
      <template #default="{ item }">
        <UiBoxRow class="attention__row" :title="item.displayTitle" :meta="item.meta">
          <template #labels
            ><UiLabel
              :tone="item.reason === 'failed' ? 'danger' : item.reason === 'processing' ? 'neutral' : 'attention'"
              >{{ item.reasonLabel }}</UiLabel
            ></template
          >
          <template #trailing
            ><UiButton size="sm" :to="item.to" :trailing-icon="ArrowRight">{{
              t("attention.openSource")
            }}</UiButton></template
          >
        </UiBoxRow>
      </template>
    </VirtualList>
    <template v-if="loaded && result && result.pageInfo.total" #footer>
      <UiPagination
        v-model:page-size="pageSize"
        :page-info="result.pageInfo"
        :size-label="t('attention.perPage')"
        :page-size-options="sizeOptions"
        @page="page = $event"
      />
    </template>
  </UiBox>
</template>

<style scoped>
.attention__filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  min-width: 0;
}
.attention__row :deep(.ui-box-row__meta) {
  white-space: normal;
  overflow-wrap: anywhere;
}

@media (max-width: 639px) {
  .attention__row {
    flex-wrap: wrap;
  }

  .attention__row :deep(.ui-box-row__main) {
    flex-basis: 100%;
  }

  .attention__row :deep(.ui-box-row__trailing) {
    margin-left: auto;
  }
}
</style>
