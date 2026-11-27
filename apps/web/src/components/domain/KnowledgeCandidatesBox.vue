<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, type RouteLocationRaw } from "vue-router";
import { storeToRefs } from "pinia";
import { Check, ExternalLink, Info, Pencil, Sparkles, X } from "lucide-vue-next";
import type { KnowledgeCandidate, KnowledgeCandidateOverlap, ProjectRecord } from "@work-intelligence/core";
import type { SelectOption } from "../ui/types";
import { useActiveRequestWatch } from "../../composables/useActiveRequestWatch";
import { useAgentReviewActions } from "../../composables/useAgentReviewActions";
import { useKnowledgeCandidates } from "../../composables/useKnowledgeCandidates";
import { useToast } from "../../composables/useToast";
import { useAgentReviewStore } from "../../stores/agent-review";
import { useKnowledgeStore } from "../../stores/knowledge";
import { useSessionsStore } from "../../stores/sessions";
import { formatPercent, formatRelative } from "../../utils/format";
import { knowledgeCandidateOverlapLabels } from "../../utils/labels";
import { knowledgeKindVisual, requestStatus } from "../../utils/status";
import AgentHandoffNotice from "./AgentHandoffNotice.vue";
import UiActionMenu from "../ui/UiActionMenu.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import VirtualList from "../VirtualList.vue";
import AgentReviewFilter from "./AgentReviewFilter.vue";
import AgentReviewVerdict from "./AgentReviewVerdict.vue";
import StatusLabel from "./StatusLabel.vue";
import { t } from "../../i18n";

const props = defineProps<{ projects: readonly ProjectRecord[]; projectRoot?: string }>();

const {
  candidates,
  openCandidateRequests,
  candidatesError,
  candidateRequesting,
  refreshCandidates,
  requestCandidates,
  cancelCandidateRequest,
  wasStoppedByUser,
  acceptCandidate,
  rejectCandidate,
  openCandidateEditor,
} = useKnowledgeCandidates();
const { candidatesLoaded, candidateBacklog } = storeToRefs(useKnowledgeStore());
const { filter, reviewedCandidates, reviewedCandidatesLoaded, reviewedCandidatesError } =
  storeToRefs(useAgentReviewStore());
const { overturn } = useAgentReviewActions();
const sessionsStore = useSessionsStore();
const { openSessionDetail } = sessionsStore;
const { showToast } = useToast();

// A finished request leaves the open list, so a missing request means the Agent submitted its candidates, unless the user stopped it here.
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
    } else if (!status && !wasStoppedByUser(request.id)) {
      showToast(
        project
          ? t("knowledge.theAgentSubmittedKnowledgeCandidatesForPleaseReview", { project })
          : t("knowledge.theAgentSubmittedKnowledgeCandidates"),
        "success",
      );
    }
  },
});

const isAgentView = computed(() => filter.value === "agent");
const openRows = computed(() =>
  isAgentView.value
    ? []
    : openCandidateRequests.value.map((request) => ({
        request,
        remaining:
          candidateBacklog.value.find((entry) => entry.projectId === request.projectId)?.highValueSessions ?? 0,
      })),
);
const backlogRows = computed(() => {
  if (!candidatesLoaded.value || isAgentView.value) return [];
  return candidateBacklog.value.flatMap((entry) => {
    const project = props.projects.find((item) => item.id === entry.projectId);
    const isOpen = openCandidateRequests.value.some((request) => request.projectId === entry.projectId);
    return project && !isOpen
      ? [{ projectId: project.id, name: project.name, highValue: entry.highValueSessions }]
      : [];
  });
});
const organizeItems = computed<SelectOption<string>[]>(() =>
  props.projects
    .filter((project) => !props.projectRoot || project.rootPath === props.projectRoot)
    .map((project) => {
      const highValue = candidateBacklog.value.find((entry) => entry.projectId === project.id)?.highValueSessions;
      const isOpen = openCandidateRequests.value.some((request) => request.projectId === project.id);
      return {
        value: project.id,
        label: project.name,
        ...(highValue !== undefined ? { count: t("knowledge.candidateBacklogCount", { n: highValue }) } : {}),
        ...(isOpen ? { disabled: true, description: t("knowledge.candidateMenuOpen") } : {}),
      };
    }),
);
const shownCandidates = computed(() => (isAgentView.value ? reviewedCandidates.value : candidates.value));
const shownLoaded = computed(() => (isAgentView.value ? reviewedCandidatesLoaded.value : candidatesLoaded.value));
const shownError = computed(() => (isAgentView.value ? reviewedCandidatesError.value : candidatesError.value));

function projectRootFor(candidate: KnowledgeCandidate): string | undefined {
  return props.projectRoot ?? props.projects.find((project) => project.id === candidate.projectId)?.rootPath;
}

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
  if (candidateRequesting.value) return;
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
          shownLoaded
            ? t(isAgentView ? 'knowledge.agentProcessedCandidates' : 'knowledge.knowledgeCandidates', {
                length: shownCandidates.length,
              })
            : t('common.knowledgeCandidates')
        "
      />
      <div class="knowledge-candidates__tools">
        <AgentReviewFilter v-model="filter" />
        <UiActionMenu
          v-if="!isAgentView"
          :label="t('knowledge.synthesizeCandidates')"
          :header="t('knowledge.chooseAProjectToSynthesize')"
          :items="organizeItems"
          variant="button"
          size="sm"
          align="end"
          @select="onRequest"
        />
      </div>
    </template>
    <UiFlash v-if="shownError" tone="danger">{{ shownError }}</UiFlash>
    <div v-if="openRows.length" class="knowledge-candidates__handoff" data-testid="knowledge-candidates-handoff">
      <AgentHandoffNotice
        :title="t('knowledge.candidateRequestsTitle')"
        :message="t('knowledge.candidateRequestMessage')"
        :command="t('knowledge.candidateRequestCommand')"
      >
        <ul class="knowledge-candidates__backlog-list">
          <li
            v-for="{ request, remaining } in openRows"
            :key="request.id"
            data-testid="knowledge-candidates-open-request"
          >
            <StatusLabel :status="requestStatus[request.status]" />
            <span>
              {{
                remaining > 0
                  ? t("knowledge.candidateBacklogOpen", {
                      project: request.projectName,
                      length: request.sourceSessionIds.length,
                      n: remaining,
                    })
                  : t("knowledge.candidateRequestWaiting", {
                      project: request.projectName,
                      length: request.sourceSessionIds.length,
                    })
              }}
              <template v-if="request.status === 'failed'">{{ t("knowledge.interruptedLastTimeCanBe") }}</template>
            </span>
            <UiButton
              size="sm"
              :disabled="candidateRequesting"
              :aria-label="t('knowledge.candidateRequestStopLabel', { project: request.projectName ?? '' })"
              @click="cancelCandidateRequest(request)"
              >{{ t("knowledge.candidateRequestStop") }}</UiButton
            >
          </li>
        </ul>
      </AgentHandoffNotice>
    </div>
    <section v-if="backlogRows.length" class="knowledge-candidates__backlog" data-testid="knowledge-candidates-backlog">
      <h3 class="knowledge-candidates__backlog-title">{{ t("knowledge.candidateBacklogTitle") }}</h3>
      <p>{{ t("knowledge.candidateBacklogHint") }}</p>
      <p>{{ t("knowledge.candidateBacklogExplainer") }}</p>
      <ul class="knowledge-candidates__backlog-list">
        <li v-for="row in backlogRows" :key="row.projectId" data-testid="knowledge-candidates-backlog-row">
          <span class="knowledge-candidates__backlog-project">{{ row.name }}</span>
          <span>{{ t("knowledge.candidateBacklogCount", { n: row.highValue }) }}</span>
          <UiButton
            size="sm"
            :disabled="candidateRequesting"
            :aria-label="t('knowledge.organizeProjectLabel', { project: row.name })"
            @click="onRequest(row.projectId)"
            >{{ t("knowledge.organizeProject") }}</UiButton
          >
        </li>
      </ul>
    </section>
    <UiSkeleton v-if="!shownLoaded && !shownError" :count="2" :label="t('knowledge.loadingKnowledgeCandidates')" />
    <p v-else-if="isAgentView && shownCandidates.length === 0" class="knowledge-candidates__empty">
      {{ t("knowledge.noAgentProcessedCandidates") }}
    </p>
    <p
      v-else-if="!isAgentView && candidates.length === 0 && openCandidateRequests.length === 0"
      class="knowledge-candidates__empty"
    >
      {{ t("knowledge.noCandidatesToReviewPress") }}
    </p>
    <VirtualList
      :items="shownCandidates"
      :enabled="shownCandidates.length > 2"
      :estimate-item-height="220"
      max-height="min(56vh, 560px)"
      :label="isAgentView ? t('knowledge.agentProcessedCandidatesList') : t('knowledge.knowledgeCandidateList')"
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
          <AgentReviewVerdict
            v-if="isAgentView"
            :verdict="candidate.status === 'accepted' ? 'accepted' : 'rejected'"
            :reason="candidate.reviewReason"
            :reviewed-at="candidate.decidedAt"
            @overturn="overturn('candidate', candidate.id, projectRootFor(candidate))"
          />
          <div
            v-if="!isAgentView && candidate.overlaps?.length"
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
          <template v-if="!isAgentView" #trailing>
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

.knowledge-candidates__handoff {
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-muted);
}

.knowledge-candidates__tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.knowledge-candidates__empty {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  color: var(--fg-muted);
  font-size: var(--text-sm);
  line-height: 1.6;
}

.knowledge-candidates__backlog {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-muted);
  color: var(--fg-muted);
  font-size: var(--text-sm);
  line-height: 1.6;
}

.knowledge-candidates__backlog p,
.knowledge-candidates__backlog-title {
  margin: 0;
}

.knowledge-candidates__backlog-title {
  color: var(--fg);
  font-size: var(--text-sm);
  font-weight: 600;
}

.knowledge-candidates__backlog-list {
  display: grid;
  gap: var(--space-1);
  margin: var(--space-1) 0 0;
  padding: 0;
  list-style: none;
}

.knowledge-candidates__backlog-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-3);
}

.knowledge-candidates__backlog-project {
  color: var(--fg);
  font-weight: 600;
  overflow-wrap: anywhere;
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
