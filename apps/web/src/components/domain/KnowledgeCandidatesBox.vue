<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { Check, ExternalLink, Pencil, Sparkles, X } from "lucide-vue-next";
import type { ProjectRecord } from "@work-intelligence/core";
import { useActiveRequestWatch } from "../../composables/useActiveRequestWatch";
import { useKnowledgeCandidates } from "../../composables/useKnowledgeCandidates";
import { useToast } from "../../composables/useToast";
import { useKnowledgeStore } from "../../stores/knowledge";
import { useSessionsStore } from "../../stores/sessions";
import { formatRelative } from "../../utils/format";
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
