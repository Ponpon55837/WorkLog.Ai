<script setup lang="ts">
import { useRoute } from "vue-router";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { ArrowRight, ChevronDown, ChevronRight, CircleCheckBig, Filter, FolderGit2 } from "lucide-vue-next";
import { ATTENTION_KINDS, type AttentionItem, type UpdateAttentionPreference } from "@work-intelligence/core";
import AttentionItemRow from "./AttentionItemRow.vue";
import ProjectFilterMenu from "./ProjectFilterMenu.vue";
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
import { useDecisionReview } from "../../composables/useDecisionReview";
import { useMediaQuery } from "../../composables/useMediaQuery";
import { useToast } from "../../composables/useToast";
import { enumQuery, pageQuery, stringQuery, useRouteQuery } from "../../composables/useRouteQuery";
import { useAttentionStore } from "../../stores/attention";
import { useProjectsStore } from "../../stores/projects";
import {
  ATTENTION_GROUP_PREVIEW,
  ATTENTION_INITIAL_ROWS,
  attentionGroupRoute,
  attentionKindKeys,
  groupAttentionItems,
  isWaitingForAgent,
  type AttentionGroup,
  type GroupedAttentionKind,
} from "../../utils/attention";
import type { ListPageSize } from "../../utils/labels";
import { errorMessage, formatRelative } from "../../utils/format";
import { t, type MessageKey } from "../../i18n";

const groupTitleKeys: Record<GroupedAttentionKind, MessageKey> = {
  decision: "attention.groupTitles.decision",
  knowledge: "attention.groupTitles.knowledge",
  knowledge_page: "attention.groupTitles.knowledgePage",
};

const route = useRoute();
const store = useAttentionStore();
const {
  projectId,
  kind,
  view,
  saving,
  page,
  pageSize,
  result,
  items,
  groups,
  loaded,
  loading,
  error,
  skipped,
  hasIncomplete,
  openDecisionRequestAt,
} = storeToRefs(store);
const { projects } = storeToRefs(useProjectsStore());
const { showToast } = useToast();
const { reviewingId, review } = useDecisionReview();
const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
useRouteQuery("attentionView", view, enumQuery(["visible", "suppressed"], "visible"));
useRouteQuery("attentionProject", projectId, stringQuery());
useRouteQuery("attentionKind", kind, enumQuery(["", ...ATTENTION_KINDS], ""));
useRouteQuery("attentionPage", page, pageQuery());
useRouteQuery("attentionSize", pageSize, enumQuery<ListPageSize>([10, 20, 50], 20));

const box = ref<InstanceType<typeof UiBox> | null>(null);
const actionError = ref("");
const showAll = ref(false);
const openGroupIds = ref<string[]>([]);

const kindItems = computed(() => [
  { value: "" as const, label: t("common.allKinds") },
  ...ATTENTION_KINDS.map((value) => ({ value, label: t(attentionKindKeys[value]) })),
]);
const viewItems = computed(() => [
  { value: "visible" as const, label: t("attention.visibleView") },
  { value: "suppressed" as const, label: t("attention.suppressedView") },
]);
const suppressedCount = computed(() => result.value?.suppressedCount ?? 0);
const countLabel = computed(() =>
  result.value?.total === null
    ? t("attention.atLeast", { count: result.value.minimumTotal })
    : String(result.value?.total ?? ""),
);
const failedSources = computed(() =>
  groups.value
    .filter((group) => group.state === "failed")
    .map((group) => t("attention.sourceFailed", { source: t(attentionKindKeys[group.kind]) })),
);
const partialCoverage = computed(() => {
  const partial = groups.value.filter((group) => group.state === "partial");
  return partial.length
    ? {
        examined: partial.reduce((sum, group) => sum + group.examined, 0),
        available: partial.reduce((sum, group) => sum + group.available, 0),
      }
    : undefined;
});
const entries = computed(() => groupAttentionItems(items.value));
const visibleEntries = computed(() => (showAll.value ? entries.value : entries.value.slice(0, ATTENTION_INITIAL_ROWS)));
const sizeOptions: readonly { value: ListPageSize; label: string }[] = [
  { value: 10, label: "10" },
  { value: 20, label: "20" },
  { value: 50, label: "50" },
];

function isWaiting(item: AttentionItem): boolean {
  return isWaitingForAgent(item, openDecisionRequestAt.value);
}

function groupTitle(group: AttentionGroup): string {
  const project =
    group.items[0]?.projectName ||
    projects.value.find((entry) => entry.id === group.projectId)?.name ||
    group.projectId;
  return t(groupTitleKeys[group.kind], { project, count: group.items.length });
}

function groupMeta(group: AttentionGroup): string {
  const waiting = group.items.filter(isWaiting).length;
  const updated = formatRelative(group.items[0]?.updatedAt ?? "");
  return waiting > 0 && waiting < group.items.length
    ? t("attention.groupMetaWaiting", { updated, waiting })
    : t("attention.groupMeta", { source: t(attentionKindKeys[group.kind]), updated });
}

function groupWaiting(group: AttentionGroup): boolean {
  return group.items.every(isWaiting);
}

function groupPreview(group: AttentionGroup): AttentionItem[] {
  return group.items.slice(0, ATTENTION_GROUP_PREVIEW);
}

function isGroupOpen(group: AttentionGroup): boolean {
  return openGroupIds.value.includes(group.id);
}

function toggleGroup(group: AttentionGroup): void {
  openGroupIds.value = isGroupOpen(group)
    ? openGroupIds.value.filter((id) => id !== group.id)
    : [...openGroupIds.value, group.id];
}

function reveal(): void {
  const element = box.value?.$el as HTMLElement | undefined;
  element?.scrollIntoView({ behavior: reduceMotion.value ? "auto" : "smooth", block: "start" });
  element?.focus({ preventScroll: true });
}

async function changePreference(item: AttentionItem, action: UpdateAttentionPreference["action"]): Promise<void> {
  if (!item.projectId || !item.preference || saving.value) return;
  actionError.value = "";
  try {
    await store.setPreference({
      projectId: item.projectId,
      kind: item.kind,
      sourceId: item.sourceId,
      sourceRevision: item.sourceRevision,
      expectedRevision: item.preference.revision,
      action,
    });
    showToast(t("attention.preferenceSaved"), "success");
  } catch (error) {
    actionError.value = errorMessage(error, t("attention.preferenceFailed"));
  }
}

// Back/forward restores the complete URL, while a user filter change starts at page one.
watch([projectId, kind, view, pageSize], () => {
  if (
    (route.query.attentionProject ?? "") !== projectId.value ||
    (route.query.attentionKind ?? "") !== kind.value ||
    (route.query.attentionView ?? "visible") !== view.value ||
    Number(route.query.attentionSize ?? 20) !== Number(pageSize.value)
  )
    page.value = 1;
});
watch([projectId, kind, view, page, pageSize], () => {
  showAll.value = false;
  openGroupIds.value = [];
});

onMounted(() => store.setActive(true));
onBeforeUnmount(() => store.setActive(false));

defineExpose({ reveal });
</script>

<template>
  <UiBox ref="box" tabindex="-1" class="attention" data-testid="attention-box">
    <template #header>
      <UiBoxTitle :title="t('dashboard.needsAttention')" />
      <UiCounter v-if="loaded && result?.minimumTotal" :count="countLabel" tone="attention" />
      <div class="attention__filters">
        <UiActionMenu
          v-model="view"
          :label="t('attention.view')"
          :items="viewItems"
          :icon="Filter"
          default-value="visible"
          size="sm"
        />
        <ProjectFilterMenu v-model="projectId" :icon="FolderGit2" size="sm" />
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
    <UiFlash v-if="actionError" tone="danger"
      >{{ actionError
      }}<template #actions
        ><UiButton
          size="sm"
          @click="
            store.reload();
            actionError = '';
          "
          >{{ t("common.refresh") }}</UiButton
        ></template
      ></UiFlash
    >
    <p v-if="loaded && suppressedCount" class="attention__note">
      {{ t("attention.suppressedCount", { count: suppressedCount }) }}
    </p>
    <UiFlash v-if="error" tone="danger"
      >{{ error
      }}<template #actions
        ><UiButton size="sm" :loading="loading" @click="store.reload()">{{ t("common.retry") }}</UiButton></template
      ></UiFlash
    >
    <UiFlash v-for="warning in failedSources" :key="warning" tone="attention"
      >{{ warning
      }}<template #actions
        ><UiButton size="sm" :loading="loading" @click="store.reload()">{{ t("common.retry") }}</UiButton></template
      ></UiFlash
    >
    <UiFlash v-if="partialCoverage" tone="attention" data-testid="attention-partial"
      >{{ t("attention.partialNotice", partialCoverage)
      }}<template #actions
        ><UiButton size="sm" :to="{ name: 'knowledge' }" :trailing-icon="ArrowRight">{{
          t("attention.viewAllInKnowledge")
        }}</UiButton></template
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
      v-else-if="loaded && !entries.length"
      compact
      :icon="hasIncomplete || suppressedCount || view === 'suppressed' ? undefined : CircleCheckBig"
      :title="
        hasIncomplete
          ? t('attention.unknownEmpty')
          : view === 'suppressed'
            ? t('attention.noSuppressed')
            : suppressedCount
              ? t('attention.allSuppressed')
              : t('attention.empty')
      "
      :description="suppressedCount ? t('attention.suppressedDescription') : t('attention.emptyDescription')"
    />
    <ul v-else-if="entries.length" class="attention__list" :aria-label="t('attention.list')">
      <template v-for="entry in visibleEntries" :key="entry.type === 'item' ? entry.item.id : entry.group.id">
        <AttentionItemRow
          v-if="entry.type === 'item'"
          :item="entry.item"
          :view="view"
          :waiting="isWaiting(entry.item)"
          :saving="saving"
          :reviewing="reviewingId === entry.item.sourceId"
          @review="review({ id: entry.item.sourceId, projectId: entry.item.projectId }, $event)"
          @preference="changePreference(entry.item, $event)"
        />
        <li v-else class="attention__group" data-testid="attention-group">
          <UiBoxRow
            tag="div"
            class="attention__group-row"
            :title="groupTitle(entry.group)"
            :meta="groupMeta(entry.group)"
          >
            <template #trailing>
              <UiLabel :tone="groupWaiting(entry.group) ? 'accent' : 'attention'">{{
                groupWaiting(entry.group) ? t("attention.waitingForAgent") : t("attention.reasons.pending")
              }}</UiLabel>
              <UiButton
                size="sm"
                :icon="isGroupOpen(entry.group) ? ChevronDown : ChevronRight"
                :aria-expanded="isGroupOpen(entry.group)"
                @click="toggleGroup(entry.group)"
                >{{
                  isGroupOpen(entry.group)
                    ? t("attention.collapseGroup")
                    : t("attention.expandGroup", { count: groupPreview(entry.group).length })
                }}</UiButton
              >
              <UiButton size="sm" :to="attentionGroupRoute(entry.group)" :trailing-icon="ArrowRight">{{
                t("attention.openSource")
              }}</UiButton>
            </template>
          </UiBoxRow>
          <ul v-if="isGroupOpen(entry.group)" class="attention__children" :aria-label="groupTitle(entry.group)">
            <AttentionItemRow
              v-for="child in groupPreview(entry.group)"
              :key="child.id"
              nested
              :item="child"
              :view="view"
              :waiting="isWaiting(child)"
              :saving="saving"
              :reviewing="reviewingId === child.sourceId"
              @review="review({ id: child.sourceId, projectId: child.projectId }, $event)"
              @preference="changePreference(child, $event)"
            />
            <li v-if="entry.group.items.length > ATTENTION_GROUP_PREVIEW" class="attention__more">
              {{ t("attention.groupMore", { count: entry.group.items.length - ATTENTION_GROUP_PREVIEW }) }}
            </li>
          </ul>
        </li>
      </template>
    </ul>
    <div v-if="entries.length > ATTENTION_INITIAL_ROWS" class="attention__toggle">
      <UiButton
        size="sm"
        :icon="showAll ? ChevronDown : ChevronRight"
        :aria-expanded="showAll"
        @click="showAll = !showAll"
        >{{
          showAll
            ? t("attention.showFewer", { count: ATTENTION_INITIAL_ROWS })
            : t("attention.showAll", { count: entries.length })
        }}</UiButton
      >
    </div>
    <template v-if="loaded && result && result.pageInfo.totalPages > 1" #footer>
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
.attention__note {
  padding: var(--space-2) var(--space-4);
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}

.attention__filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  min-width: 0;
}

.attention__list,
.attention__children {
  margin: 0;
  padding: 0;
  list-style: none;
}

.attention__group {
  border-top: 1px solid var(--border-muted);
}

.attention__group:first-child {
  border-top: 0;
}

.attention__children {
  border-top: 1px solid var(--border-muted);
}

.attention__group-row :deep(.ui-box-row__trailing) {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.attention__group-row :deep(.ui-box-row__meta) {
  white-space: normal;
  overflow-wrap: anywhere;
}

.attention__more {
  padding: var(--space-2) var(--space-4) var(--space-2) var(--space-6);
  border-top: 1px solid var(--border-muted);
  background: var(--bg-subtle);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.attention__toggle {
  display: flex;
  justify-content: center;
  padding: var(--space-2) var(--space-4);
  border-top: 1px solid var(--border-muted);
}

@media (max-width: 639px) {
  .attention__group-row {
    flex-wrap: wrap;
  }

  .attention__group-row :deep(.ui-box-row__main) {
    flex-basis: 100%;
  }

  .attention__group-row :deep(.ui-box-row__trailing) {
    margin-left: auto;
  }
}
</style>
