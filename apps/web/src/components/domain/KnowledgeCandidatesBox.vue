<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, type RouteLocationRaw } from "vue-router";
import { storeToRefs } from "pinia";
import { Check, ExternalLink, Info, Pencil, Sparkles, X } from "lucide-vue-next";
import type { KnowledgeCandidate, KnowledgeCandidateOverlap, ProjectRecord } from "@work-intelligence/core";
import { useActiveRequestWatch } from "../../composables/useActiveRequestWatch";
import { useKnowledgeCandidates } from "../../composables/useKnowledgeCandidates";
import { useToast } from "../../composables/useToast";
import { useKnowledgeStore } from "../../stores/knowledge";
import { useSessionsStore } from "../../stores/sessions";
import { formatPercent, formatRelative } from "../../utils/format";
import { knowledgeCandidateOverlapLabels } from "../../utils/labels";
import { knowledgeKindVisual } from "../../utils/status";
import UiActionMenu from "../ui/UiActionMenu.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import VirtualList from "../VirtualList.vue";
import StatusLabel from "./StatusLabel.vue";
import { t } from "../../i18n";

/**
 * Agent-proposed Knowledge waiting for review. Accepting records it as Knowledge; nothing becomes
 * Knowledge without a person's decision here.
 */
const props = defineProps<{ projects: readonly ProjectRecord[]; projectRoot?: string }>();

const {
  candidates,
  openCandidateRequests,
  candidatesError,
  refreshCandidates,
  requestCandidates,
  acceptCandidate,
  rejectCandidate,
  openCandidateEditor,
} = useKnowledgeCandidates();
const { candidatesLoaded } = storeToRefs(useKnowledgeStore());
const sessionsStore = useSessionsStore();
const { openSessionDetail } = sessionsStore;
const { showToast } = useToast();

// A finished request leaves the open list, so a missing request means the Agent submitted its candidates.
useActiveRequestWatch({
  requests: () => openCandidateRequests.value,
  check: () => refreshCandidates(props.projectRoot),
  scope: () => props.projectRoot ?? "",
  onSettled: (request, status) => {
    const project = request.projectName;
    if (status === "failed") {
      showToast(
        project
          ? t("knowledge.knowledgeCandidateSynthesisForDid", { project })
          : t("knowledge.knowledgeCandidateSynthesisDidNot"),
        "danger",
      );
    } else if (!status) {
      showToast(
        project
          ? t("knowledge.theAgentSubmittedKnowledgeCandidatesForPleaseReview", { project })
          : t("knowledge.theAgentSubmittedKnowledgeCandidates"),
        "success",
      );
    }
  },
});

const requestItems = computed(() => props.projects.map((project) => ({ value: project.id, label: project.name })));

function overlapLabel(overlap: KnowledgeCandidateOverlap): string {
  return (
    knowledgeCandidateOverlapLabels[`${overlap.relation}:${overlap.type}`] ?? t("labels.overlapDuplicateKnowledge")
  );
}

// Opens the matched Knowledge in the list's history panel, scoped to the candidate's own project.
function overlapKnowledgeLink(candidate: KnowledgeCandidate, overlap: KnowledgeCandidateOverlap): RouteLocationRaw {
  return { name: "knowledge", query: { project: candidate.projectId, knowledge: overlap.id } };
}

function onRequest(projectId: string): void {
  const project = props.projects.find((item) => item.id === projectId);
  if (project) {
    void requestCandidates(project, props.projectRoot);
  }
}
</script>

<template>
  <UiBox class="knowledge-candidates" data-testid="knowledge-candidates">
    <template #header>
      <UiBoxTitle
        :icon="Sparkles"
        :title="
          candidatesLoaded
            ? t('knowledge.knowledgeCandidates', { length: candidates.length })
            : t('common.knowledgeCandidates')
        "
      />
      <UiActionMenu
        :label="t('knowledge.synthesizeCandidates')"
        :header="t('knowledge.chooseAProjectToSynthesize')"
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
      {{
        t("knowledge.hasSessionsWaitingForThe", {
          projectName: request.projectName,
          length: request.sourceSessionIds.length,
          value: request.status === "failed" ? t("knowledge.interruptedLastTimeCanBe") : "",
        })
      }}
    </UiFlash>
    <UiSkeleton
      v-if="!candidatesLoaded && !candidatesError"
      :count="2"
      :label="t('knowledge.loadingKnowledgeCandidates')"
    />
    <p v-else-if="candidates.length === 0 && openCandidateRequests.length === 0" class="knowledge-candidates__empty">
      {{ t("knowledge.noCandidatesToReviewPress") }}
    </p>
    <VirtualList
      :items="candidates"
      :enabled="candidates.length > 2"
      :estimate-item-height="220"
      max-height="min(56vh, 560px)"
      :label="t('knowledge.knowledgeCandidateList')"
    >
      <template #default="{ item: candidate }">
        <UiBoxRow tag="article" data-testid="knowledge-candidate">
          <template #leading>
            <component
              :is="knowledgeKindVisual[candidate.kind].icon"
              :size="16"
              :stroke-width="1.75"
              aria-hidden="true"
            />
          </template>
          <template #title>{{ candidate.title }}</template>
          <template #labels>
            <StatusLabel :status="knowledgeKindVisual[candidate.kind]" :show-icon="false" />
          </template>
          <template #meta>
            <span v-if="candidate.projectName">{{ candidate.projectName }} · </span>
            <span>{{ t("knowledge.proposed", { value: formatRelative(candidate.createdAt) }) }}</span>
          </template>
          <p class="knowledge-candidates__body">{{ candidate.body }}</p>
          <p class="knowledge-candidates__rationale">
            {{ t("knowledge.rationale", { rationale: candidate.rationale }) }}
          </p>
          <div
            v-if="candidate.overlaps?.length"
            class="knowledge-candidates__overlaps"
            role="note"
            data-testid="knowledge-candidate-overlaps"
          >
            <p class="knowledge-candidates__overlaps-note">
              <Info :size="16" :stroke-width="1.75" aria-hidden="true" />
              <span>{{ t("knowledge.overlapAdvisory") }}</span>
            </p>
            <ul class="knowledge-candidates__overlaps-list" :aria-label="t('knowledge.overlapList')">
              <li v-for="overlap in candidate.overlaps" :key="`${overlap.type}:${overlap.id}`">
                <span class="knowledge-candidates__overlap-relation">{{ overlapLabel(overlap) }}</span>
                <RouterLink
                  v-if="overlap.type === 'knowledge' && overlap.title"
                  class="knowledge-candidates__overlap-link"
                  :to="overlapKnowledgeLink(candidate, overlap)"
                  >{{ overlap.title }}</RouterLink
                >
                <span v-else-if="overlap.title" class="knowledge-candidates__overlap-title">{{ overlap.title }}</span>
                <span v-else class="knowledge-candidates__overlap-gone">{{ t("knowledge.overlapRecordGone") }}</span>
                <span class="knowledge-candidates__overlap-score">{{
                  t("knowledge.overlapSimilarity", { score: formatPercent(overlap.score) })
                }}</span>
              </li>
            </ul>
          </div>
          <div class="knowledge-candidates__chips">
            <UiButton
              v-if="candidate.sessionId"
              size="sm"
              variant="invisible"
              :icon="ExternalLink"
              @click="openSessionDetail(candidate.sessionId)"
              >{{ candidate.sessionTitle ?? t("common.sourceSession") }}</UiButton
            >
            <UiLabel v-for="tag in candidate.tags" :key="`tag-${tag}`">#{{ tag }}</UiLabel>
            <code v-for="pattern in candidate.appliesTo" :key="`applies-${pattern}`">{{
              t("knowledge.appliesTo", { pattern })
            }}</code>
          </div>
          <template #trailing>
            <div class="knowledge-candidates__actions">
              <UiButton size="sm" variant="primary" :icon="Check" @click="acceptCandidate(candidate, projectRoot)">{{
                t("knowledge.accept")
              }}</UiButton>
              <UiButton size="sm" :icon="Pencil" @click="openCandidateEditor(candidate)">{{
                t("knowledge.editAndAccept")
              }}</UiButton>
              <UiButton size="sm" :icon="X" @click="rejectCandidate(candidate, projectRoot)">{{
                t("knowledge.reject")
              }}</UiButton>
            </div>
          </template>
        </UiBoxRow>
      </template>
    </VirtualList>
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

.knowledge-candidates__overlaps {
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius);
  background: var(--bg-subtle);
  font-size: var(--text-sm);
}

.knowledge-candidates__overlaps-note {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  color: var(--fg-muted);
}

.knowledge-candidates__overlaps-note svg {
  flex: none;
}

.knowledge-candidates__overlaps-list {
  display: grid;
  gap: var(--space-1);
  margin: var(--space-1) 0 0;
  padding: 0 0 0 calc(16px + var(--space-2));
  list-style: none;
}

.knowledge-candidates__overlaps-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 var(--space-2);
  min-width: 0;
}

.knowledge-candidates__overlap-relation,
.knowledge-candidates__overlap-score,
.knowledge-candidates__overlap-gone {
  color: var(--fg-muted);
}

.knowledge-candidates__overlap-link,
.knowledge-candidates__overlap-title {
  color: var(--fg);
  overflow-wrap: anywhere;
}

.knowledge-candidates__overlap-link {
  color: var(--accent);
  text-decoration: none;
}

.knowledge-candidates__overlap-link:hover {
  text-decoration: underline;
}

.knowledge-candidates__overlap-score {
  font-size: var(--text-xs);
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
