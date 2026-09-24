<script setup lang="ts">
import { computed, watch } from "vue";
import { Check, ExternalLink, Pencil, Sparkles, X } from "lucide-vue-next";
import type { ProjectRecord } from "@work-intelligence/core";
import { useKnowledgeCandidates } from "../../composables/useKnowledgeCandidates";
import { useSessionDetail } from "../../composables/useSessionDetail";
import { formatRelative } from "../../utils/format";
import { knowledgeKindVisual } from "../../utils/status";
import UiActionMenu from "../ui/UiActionMenu.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiLabel from "../ui/UiLabel.vue";
import StatusLabel from "./StatusLabel.vue";

/**
 * Agent-proposed Knowledge waiting for review. Accepting records it as Knowledge; nothing becomes
 * Knowledge without a person's decision here.
 */
const props = defineProps<{ projects: readonly ProjectRecord[]; projectRoot?: string }>();

const {
  candidates,
  openCandidateRequests,
  candidatesError,
  loadCandidates,
  requestCandidates,
  acceptCandidate,
  rejectCandidate,
  openCandidateEditor,
} = useKnowledgeCandidates();
const { openSessionDetail } = useSessionDetail();

const requestItems = computed(() => props.projects.map((project) => ({ value: project.id, label: project.name })));

function onRequest(projectId: string): void {
  const project = props.projects.find((item) => item.id === projectId);
  if (project) {
    void requestCandidates(project, props.projectRoot);
  }
}

watch(
  () => props.projectRoot,
  (root) => void loadCandidates(root),
  { immediate: true },
);
</script>

<template>
  <UiBox class="knowledge-candidates" data-testid="knowledge-candidates">
    <template #header>
      <UiBoxTitle :icon="Sparkles" :title="`${candidates.length} 筆 Knowledge 候選`" />
      <UiActionMenu
        label="整理候選"
        header="選擇要整理的專案"
        variant="button"
        size="sm"
        align="end"
        :items="requestItems"
        @select="onRequest"
      />
    </template>
    <UiFlash v-if="candidatesError" tone="danger">{{ candidatesError }}</UiFlash>
    <UiFlash
      v-for="request in openCandidateRequests"
      :key="request.id"
      :tone="request.status === 'failed' ? 'attention' : 'accent'"
    >
      {{ request.projectName }} 有 {{ request.sourceSessionIds.length }} 筆 Session 等待 Agent 整理{{
        request.status === "failed" ? "（上次中斷，可重新處理）" : ""
      }}。在 Claude Code 或 Codex 說「整理 Knowledge 候選」即可。
    </UiFlash>
    <p v-if="candidates.length === 0 && openCandidateRequests.length === 0" class="knowledge-candidates__empty">
      沒有待審核的候選。按「整理候選」選擇專案，再請 Agent 從已記錄的 Session 整理；候選要在這裡接受後才會成為
      Knowledge。
    </p>
    <UiBoxRow v-for="candidate in candidates" :key="candidate.id" tag="article" data-testid="knowledge-candidate">
      <template #leading>
        <component :is="knowledgeKindVisual[candidate.kind].icon" :size="16" :stroke-width="1.75" aria-hidden="true" />
      </template>
      <template #title>{{ candidate.title }}</template>
      <template #labels>
        <StatusLabel :status="knowledgeKindVisual[candidate.kind]" :show-icon="false" />
      </template>
      <template #meta>
        <span v-if="candidate.projectName">{{ candidate.projectName }} · </span>
        <span>提出於 {{ formatRelative(candidate.createdAt) }}</span>
      </template>
      <p class="knowledge-candidates__body">{{ candidate.body }}</p>
      <p class="knowledge-candidates__rationale">依據：{{ candidate.rationale }}</p>
      <div class="knowledge-candidates__chips">
        <UiButton
          v-if="candidate.sessionId"
          size="sm"
          variant="invisible"
          :icon="ExternalLink"
          @click="openSessionDetail(candidate.sessionId)"
          >{{ candidate.sessionTitle ?? "來源 Session" }}</UiButton
        >
        <UiLabel v-for="tag in candidate.tags" :key="`tag-${tag}`">#{{ tag }}</UiLabel>
        <code v-for="pattern in candidate.appliesTo" :key="`applies-${pattern}`">適用 {{ pattern }}</code>
      </div>
      <template #trailing>
        <div class="knowledge-candidates__actions">
          <UiButton size="sm" variant="primary" :icon="Check" @click="acceptCandidate(candidate, projectRoot)"
            >接受</UiButton
          >
          <UiButton size="sm" :icon="Pencil" @click="openCandidateEditor(candidate)">修改後接受</UiButton>
          <UiButton size="sm" :icon="X" @click="rejectCandidate(candidate, projectRoot)">拒絕</UiButton>
        </div>
      </template>
    </UiBoxRow>
  </UiBox>
</template>

<style scoped>
.knowledge-candidates {
  margin-bottom: var(--space-4);
}

.knowledge-candidates__empty {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  color: var(--fg-muted);
  font-size: var(--text-sm);
  line-height: 1.6;
}

.knowledge-candidates__body {
  margin-top: var(--space-2);
  color: var(--fg);
  font-size: var(--text-sm);
  line-height: 1.6;
  white-space: pre-line;
}

.knowledge-candidates__rationale {
  margin-top: var(--space-1);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.knowledge-candidates__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.knowledge-candidates__chips code {
  color: var(--fg-muted);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}

.knowledge-candidates__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-1);
}

@media (max-width: 639px) {
  .knowledge-candidates__actions {
    justify-content: flex-start;
  }
}
</style>
