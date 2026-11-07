<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import { storeToRefs } from "pinia";
import { Eye } from "lucide-vue-next";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiPagination from "../ui/UiPagination.vue";
import UiSelect from "../ui/UiSelect.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import { enumQuery, pageQuery, stringQuery, useRouteQuery } from "../../composables/useRouteQuery";
import { useAgentReadsStore } from "../../stores/agent-reads";
import { useProjectsStore } from "../../stores/projects";
import { useSessionsStore } from "../../stores/sessions";
import { formatDate, formatMilliseconds } from "../../utils/format";
import { listPageSizeOptions } from "../../utils/labels";
import { t, type MessageKey } from "../../i18n";

/**
 * Passive audit of what Agents were given through MCP reads: when, which tool and client, which project, and the
 * returned Session ids (ids only; no query or content is stored), plus each read's duration and failure code and a
 * per-tool latency summary. Session ids open the Session panel.
 */
const agentReadsStore = useAgentReadsStore();
const {
  projectId,
  agent,
  page,
  pageSize,
  reads,
  pageInfo,
  agentOptions,
  loaded,
  error,
  toolStats,
  statsLoaded,
  statsError,
} = storeToRefs(agentReadsStore);
const { trackedProjects } = storeToRefs(useProjectsStore());
const { openSessionDetail } = useSessionsStore();

const pageSizes = listPageSizeOptions.map((option) => option.value);
// Codes come from the MCP read wrapper; an unknown code is shown as stored.
const errorLabelKeys: Readonly<Record<string, MessageKey>> = {
  invalid_input: "systemStatus.agentReadsErrorInvalidInput",
  database_busy: "systemStatus.agentReadsErrorDatabaseBusy",
  restart_required: "systemStatus.agentReadsErrorRestartRequired",
  internal_error: "systemStatus.agentReadsErrorInternal",
};

useRouteQuery("readsProject", projectId, stringQuery());
useRouteQuery("readsAgent", agent, stringQuery());
useRouteQuery("readsPage", page, pageQuery());
useRouteQuery("readsSize", pageSize, enumQuery(pageSizes, 10));

const projectOptions = computed(() => [
  { value: "", label: t("systemStatus.agentReadsAllProjects") },
  ...trackedProjects.value.map((project) => ({ value: project.id, label: project.name })),
]);
const agentFilterOptions = computed(() => [
  { value: "", label: t("systemStatus.agentReadsAllAgents") },
  ...agentOptions.value.map((name) => ({ value: name, label: name })),
]);

function errorLabel(code: string): string {
  const key = errorLabelKeys[code];
  return key ? t(key) : t("systemStatus.agentReadsErrorOther", { code });
}

function milliseconds(value: number | null): string {
  return value === null ? "—" : formatMilliseconds(value);
}

function openSession(sessionId: string): void {
  void openSessionDetail(sessionId, t("systemStatus.agentReadsCouldNotOpenSession"));
}

onMounted(() => agentReadsStore.setListActive(true));
onBeforeUnmount(() => agentReadsStore.setListActive(false));
</script>

<template>
  <UiBox data-testid="agent-reads">
    <template #header>
      <UiBoxTitle
        :icon="Eye"
        :title="t('systemStatus.agentReadsTitle')"
        :count="loaded ? pageInfo?.total : undefined"
      />
      <UiSelect
        v-model="projectId"
        :options="projectOptions"
        :label="t('systemStatus.agentReadsProjectFilter')"
        size="sm"
      />
      <UiSelect
        v-model="agent"
        :options="agentFilterOptions"
        :label="t('systemStatus.agentReadsAgentFilter')"
        size="sm"
      />
    </template>

    <p class="agent-reads__hint">{{ t("systemStatus.agentReadsHint") }}</p>

    <!-- No reads yet: the list's empty state already says so, so the stats section stays hidden. -->
    <section
      v-if="statsError || !statsLoaded || toolStats.length > 0"
      class="agent-reads__stats"
      data-testid="agent-read-stats"
      :aria-label="t('systemStatus.agentReadStatsTitle')"
    >
      <h3 class="agent-reads__stats-title">{{ t("systemStatus.agentReadStatsTitle") }}</h3>
      <UiFlash v-if="statsError" tone="danger" :title="t('systemStatus.agentReadStatsCouldNotLoad')">
        {{ statsError }}
        <template #actions
          ><UiButton size="sm" @click="agentReadsStore.reloadStats">{{ t("common.retry") }}</UiButton></template
        >
      </UiFlash>
      <UiSkeleton v-else-if="!statsLoaded" :count="2" :label="t('systemStatus.agentReadStatsLoading')" />
      <template v-else>
        <p class="agent-reads__stats-hint">{{ t("systemStatus.agentReadStatsHint") }}</p>
        <div class="agent-reads__stats-scroll">
          <table class="agent-reads__stats-table">
            <thead>
              <tr>
                <th scope="col">{{ t("systemStatus.agentReadStatsTool") }}</th>
                <th scope="col" class="is-numeric">{{ t("systemStatus.agentReadStatsCount") }}</th>
                <th scope="col" class="is-numeric">{{ t("systemStatus.agentReadStatsP50") }}</th>
                <th scope="col" class="is-numeric">{{ t("systemStatus.agentReadStatsP95") }}</th>
                <th scope="col" class="is-numeric">{{ t("systemStatus.agentReadStatsErrors") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="stat in toolStats" :key="stat.tool">
                <th scope="row">
                  <code>{{ stat.tool }}</code>
                </th>
                <td class="is-numeric">{{ stat.count }}</td>
                <td class="is-numeric">{{ milliseconds(stat.p50Ms) }}</td>
                <td class="is-numeric">{{ milliseconds(stat.p95Ms) }}</td>
                <td :class="['is-numeric', { 'is-danger': stat.errorCount > 0 }]">{{ stat.errorCount }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </section>

    <UiFlash v-if="error" tone="danger" :title="t('systemStatus.agentReadsCouldNotLoad')">
      {{ error }}
      <template #actions
        ><UiButton size="sm" @click="agentReadsStore.reload">{{ t("common.retry") }}</UiButton></template
      >
    </UiFlash>
    <UiSkeleton v-else-if="!loaded" :count="4" :label="t('systemStatus.agentReadsLoading')" />
    <UiEmptyState
      v-else-if="reads.length === 0"
      compact
      :icon="Eye"
      :title="t('systemStatus.agentReadsEmptyTitle')"
      :description="t('systemStatus.agentReadsEmptyHint')"
    />
    <div
      v-else
      class="agent-reads__list"
      data-testid="agent-reads-list"
      tabindex="0"
      :aria-label="t('systemStatus.agentReadsTitle')"
    >
      <UiBoxRow v-for="read in reads" :key="read.id">
        <template #title>
          <code>{{ read.tool }}</code>
        </template>
        <template #labels>
          <UiLabel tone="accent">{{ read.agentClient ?? t("systemStatus.agentReadsUnknownAgent") }}</UiLabel>
          <UiLabel>{{ read.projectName ?? t("systemStatus.agentReadsNoProject") }}</UiLabel>
          <UiLabel v-if="read.errorCode" tone="danger">{{ errorLabel(read.errorCode) }}</UiLabel>
        </template>
        <template #meta>
          <time :datetime="read.at">{{ formatDate(read.at) }}</time>
          <span>{{ t("systemStatus.agentReadsReturned", { count: read.returnedCount }) }}</span>
          <span v-if="read.durationMs !== undefined">{{
            t("systemStatus.agentReadsDuration", { value: formatMilliseconds(read.durationMs) })
          }}</span>
        </template>
        <div v-if="read.sessionIds.length > 0 || read.knowledgeIds.length > 0" class="agent-reads__ids">
          <button
            v-for="sessionId in read.sessionIds"
            :key="sessionId"
            type="button"
            class="agent-reads__id"
            :title="t('systemStatus.agentReadsOpenSession', { id: sessionId })"
            @click="openSession(sessionId)"
          >
            Session {{ sessionId.slice(0, 8) }}
          </button>
          <span v-if="read.knowledgeIds.length > 0">{{
            t("systemStatus.agentReadsKnowledgeCount", { count: read.knowledgeIds.length })
          }}</span>
          <span v-if="read.omittedSessionCount + read.omittedKnowledgeCount > 0">{{
            t("systemStatus.agentReadsOmitted", { count: read.omittedSessionCount + read.omittedKnowledgeCount })
          }}</span>
        </div>
      </UiBoxRow>
    </div>

    <template v-if="loaded && pageInfo && pageInfo.total > 0" #footer>
      <UiPagination
        v-model:page-size="pageSize"
        :page-info="pageInfo"
        :size-label="t('systemStatus.agentReadsPageSize')"
        @page="page = $event"
      />
    </template>
  </UiBox>
</template>

<style scoped>
.agent-reads__hint {
  margin: 0;
  padding: var(--space-2) var(--space-4);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.agent-reads__stats {
  padding: var(--space-2) var(--space-4) var(--space-3);
  border-bottom: 1px solid var(--border-muted);
}

.agent-reads__stats-title {
  margin: 0 0 var(--space-1);
  font-size: var(--text-sm);
  font-weight: 600;
}

.agent-reads__stats-hint {
  margin: 0 0 var(--space-2);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.agent-reads__stats-scroll {
  max-height: 240px;
  overflow: auto;
  overscroll-behavior: contain;
}

.agent-reads__stats-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-xs);
}

.agent-reads__stats-table th,
.agent-reads__stats-table td {
  padding: var(--space-1) var(--space-2);
  border-bottom: 1px solid var(--border-muted);
  text-align: left;
  white-space: nowrap;
}

.agent-reads__stats-table thead th {
  color: var(--fg-muted);
  font-weight: 600;
}

.agent-reads__stats-table tbody th {
  font-weight: 400;
}

.agent-reads__stats-table .is-numeric {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.agent-reads__stats-table .is-danger {
  color: var(--danger);
}

.agent-reads__list {
  max-height: 420px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.agent-reads__ids {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-1);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.agent-reads__id {
  padding: 0 var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--accent);
  font: inherit;
  cursor: pointer;
}

.agent-reads__id:hover {
  background: var(--accent-soft);
}

.agent-reads__id:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
</style>
