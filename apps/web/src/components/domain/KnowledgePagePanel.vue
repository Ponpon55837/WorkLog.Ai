<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { ExternalLink, GitCompare, History, Pencil, RefreshCw, X } from "lucide-vue-next";
import { KNOWLEDGE_PAGE_INSUFFICIENT, type ProjectRecord } from "@work-intelligence/core";
import { useToast } from "../../composables/useToast";
import { useKnowledgePagesStore } from "../../stores/knowledge-pages";
import { useSessionsStore } from "../../stores/sessions";
import { errorMessage, formatDate, formatRelative } from "../../utils/format";
import { knowledgePageReviewReasonLabels, knowledgePageStatusVisual } from "../../utils/status";
import UiButton from "../ui/UiButton.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiSidePanel from "../ui/UiSidePanel.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import KnowledgePageDiff from "./KnowledgePageDiff.vue";
import KnowledgePageEditorDialog from "./KnowledgePageEditorDialog.vue";
import StatusLabel from "./StatusLabel.vue";
import { t } from "../../i18n";

/** One standing Knowledge page: its cited sections, its version history, and the edit and update actions. */
const props = defineProps<{ projects: readonly ProjectRecord[] }>();

const authorLabels = { agent: "Agent", web: t("knowledge.editedByHand") } as const;

const pagesStore = useKnowledgePagesStore();
const { openPage, versions, versionsLoading, versionsError, sources } = storeToRefs(pagesStore);
const sessionsStore = useSessionsStore();
const { showToast } = useToast();

/** The version shown; null shows the current page. */
const shownVersion = ref<number | null>(null);
const editorOpen = ref(false);
const comparing = ref(false);
const requesting = ref(false);

const project = computed(() => props.projects.find((item) => item.id === openPage.value?.projectId));
const shown = computed(() => {
  const version = versions.value.find((item) => item.version === shownVersion.value);
  return version ?? openPage.value;
});
/** The latest version before the one shown, when the page has one. */
const previousVersion = computed(() => {
  const current = shownVersion.value ?? openPage.value?.version ?? 0;
  const earlier = versions.value.filter((item) => item.version < current);
  return earlier.sort((a, b) => b.version - a.version)[0];
});
const sourceTitles = computed(() => {
  const titles = new Map(sources.value.map((source) => [source.id, source.title]));
  for (const section of openPage.value?.reviewSections ?? []) {
    for (const source of section.sources) titles.set(source.sourceSessionId, source.title);
  }
  return titles;
});

function reviewSourcesForHeading(heading: string) {
  if (shownVersion.value !== null) return [];
  return openPage.value?.reviewSections?.find((section) => section.heading === heading)?.sources ?? [];
}

function close(): void {
  pagesStore.closePage();
}

function openSource(sessionId: string): void {
  // The Session panel is also a modal side panel; close this one so focus moves cleanly.
  close();
  void sessionsStore.openSessionDetail(sessionId, t("knowledge.couldNotLoadTheSourceSessionOfThis"));
}

async function requestUpdate(): Promise<void> {
  const page = openPage.value;
  if (!page || !project.value) return;
  requesting.value = true;
  try {
    const result = await pagesStore.requestUpdate({ projectRoot: project.value.rootPath, slug: page.slug });
    showToast(
      result.outcome === "knowledge_page_update_requested"
        ? t("knowledge.updateRequestedSayUpdateKnowledge")
        : (result.reason ?? t("knowledge.couldNotRequestAnUpdate")),
      result.outcome === "knowledge_page_update_requested" ? "success" : "danger",
    );
  } catch (error) {
    showToast(errorMessage(error, t("knowledge.couldNotRequestAnUpdate")), "danger");
  } finally {
    requesting.value = false;
  }
}

watch(
  () => openPage.value?.id,
  () => {
    shownVersion.value = null;
  },
);

watch([() => openPage.value?.id, shownVersion], () => {
  comparing.value = false;
});
</script>

<template>
  <UiSidePanel
    :open="Boolean(openPage)"
    :label="t('common.knowledgePages')"
    :width="720"
    storage-key="knowledge-page"
    @close="close"
  >
    <template #header>
      <div class="page-panel__top">
        <span class="page-panel__eyebrow">{{ project?.name ?? t("common.knowledgePages") }}</span>
        <UiIconButton :icon="X" :label="t('knowledge.closeKnowledgePage')" @click="close" />
      </div>
      <h2 class="page-panel__title">{{ shown?.title }}</h2>
      <p class="page-panel__question">{{ shown?.question }}</p>
      <div v-if="openPage" class="page-panel__meta">
        <StatusLabel :status="knowledgePageStatusVisual[openPage.status]" />
        <UiLabel v-if="openPage.needsReview" tone="danger">{{ t("knowledge.citedSourcesNeedChecking") }}</UiLabel>
        <UiLabel v-if="openPage.newSessionCount > 0" tone="accent">{{
          t("knowledge.newSessionsToAssessCount", { newSessionCount: openPage.newSessionCount })
        }}</UiLabel>
        <UiLabel v-if="openPage.updateRequestedAt" tone="accent">{{ t("knowledge.updateRequested") }}</UiLabel>
      </div>
      <div class="page-panel__actions">
        <UiButton size="sm" :icon="RefreshCw" :loading="requesting" @click="requestUpdate">{{
          t("knowledge.askAgentToUpdate")
        }}</UiButton>
        <UiButton size="sm" :icon="Pencil" :disabled="shownVersion !== null" @click="editorOpen = true">{{
          t("knowledge.editedByHand")
        }}</UiButton>
        <UiButton
          v-if="previousVersion"
          size="sm"
          :icon="GitCompare"
          :aria-pressed="comparing"
          @click="comparing = !comparing"
          >{{ comparing ? t("knowledge.closeComparison") : t("knowledge.compareWithPrevious") }}</UiButton
        >
      </div>
    </template>

    <UiFlash v-if="shownVersion !== null" tone="accent">
      {{ t("knowledge.viewingVersion", { shownVersion }) }}
      <template #actions
        ><UiButton size="sm" @click="shownVersion = null">{{ t("knowledge.backToCurrentVersion") }}</UiButton></template
      >
    </UiFlash>

    <KnowledgePageDiff
      v-if="comparing && previousVersion && shown"
      :previous-version="previousVersion.version"
      :previous="previousVersion.sections"
      :current="shown.sections"
    />

    <section
      v-for="(section, index) in comparing && previousVersion ? [] : (shown?.sections ?? [])"
      :key="`${index}-${section.heading}`"
      class="page-panel__section"
    >
      <h3>{{ section.heading }}</h3>
      <p :class="{ 'page-panel__insufficient': section.content === KNOWLEDGE_PAGE_INSUFFICIENT }">
        {{ section.content }}
      </p>
      <UiFlash
        v-if="reviewSourcesForHeading(section.heading).length > 0"
        tone="danger"
        :title="t('knowledge.theseSourcesChangedAfterThe')"
      >
        <div class="page-panel__review-list">
          <div v-for="source in reviewSourcesForHeading(section.heading)" :key="source.sourceSessionId">
            <UiButton size="sm" variant="invisible" :icon="ExternalLink" @click="openSource(source.sourceSessionId)">{{
              source.title
            }}</UiButton>
            <span>{{
              source.reasons.map((reason) => knowledgePageReviewReasonLabels[reason]).join(t("knowledge.semicolon"))
            }}</span>
          </div>
        </div>
      </UiFlash>
      <div v-if="section.sourceSessionIds.length > 0" class="page-panel__sources">
        <span class="page-panel__sources-label">{{ t("knowledge.source") }}</span>
        <UiButton
          v-for="sessionId in section.sourceSessionIds"
          :key="sessionId"
          size="sm"
          variant="invisible"
          :icon="ExternalLink"
          :disabled="!sourceTitles.has(sessionId)"
          :title="sourceTitles.has(sessionId) ? undefined : t('knowledge.theSourceSessionIsVoided')"
          @click="openSource(sessionId)"
          >{{ sourceTitles.get(sessionId) ?? `Session ${sessionId.slice(0, 8)}` }}</UiButton
        >
      </div>
    </section>

    <section class="page-panel__history" aria-labelledby="knowledge-page-history-title">
      <h3 id="knowledge-page-history-title">
        <History :size="16" aria-hidden="true" /> {{ t("knowledge.versionHistory") }}
      </h3>
      <UiSkeleton v-if="versionsLoading" variant="text" :count="3" />
      <UiFlash v-else-if="versionsError" tone="danger">{{ versionsError }}</UiFlash>
      <ol v-else class="page-panel__versions">
        <li v-for="version in versions" :key="version.id">
          <button
            type="button"
            class="page-panel__version"
            :aria-current="(shownVersion ?? openPage?.version) === version.version ? 'true' : undefined"
            @click="shownVersion = version.version === openPage?.version ? null : version.version"
          >
            <strong>{{ t("knowledge.version", { version: version.version }) }}</strong>
            <span>{{ authorLabels[version.author] }}</span>
            <time :datetime="version.createdAt" :title="formatDate(version.createdAt)">{{
              formatRelative(version.createdAt)
            }}</time>
          </button>
        </li>
      </ol>
    </section>

    <KnowledgePageEditorDialog :open="editorOpen" :page="openPage" @close="editorOpen = false" />
  </UiSidePanel>
</template>

<style scoped>
.page-panel__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.page-panel__eyebrow {
  color: var(--fg-muted);
  font-size: var(--text-xs);
  font-weight: 600;
}

.page-panel__title {
  margin-top: var(--space-2);
  font-size: var(--text-xl);
  font-weight: 600;
}

.page-panel__question {
  margin-top: var(--space-1);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.page-panel__meta,
.page-panel__actions,
.page-panel__sources {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.page-panel__section {
  padding-block: var(--space-3);
  border-bottom: 1px solid var(--border-muted);
}

.page-panel__section h3,
.page-panel__history h3 {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-md);
  font-weight: 600;
}

.page-panel__section p {
  margin-top: var(--space-1);
  font-size: var(--text-sm);
  line-height: 1.7;
  white-space: pre-line;
}

.page-panel__review-list {
  display: grid;
  gap: var(--space-1);
}

.page-panel__review-list > div {
  display: grid;
  gap: var(--space-1);
  justify-items: start;
}

.page-panel__insufficient {
  color: var(--fg-muted);
  font-style: italic;
}

.page-panel__sources-label {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.page-panel__history {
  padding-block: var(--space-4);
}

.page-panel__versions {
  display: grid;
  gap: var(--space-1);
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
}

.page-panel__version {
  display: flex;
  width: 100%;
  gap: var(--space-3);
  align-items: baseline;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius);
  background: none;
  color: var(--fg);
  font: inherit;
  font-size: var(--text-sm);
  text-align: start;
  cursor: pointer;
}

.page-panel__version[aria-current="true"] {
  border-color: var(--accent);
}

.page-panel__version span,
.page-panel__version time {
  color: var(--fg-muted);
}

.page-panel__version time {
  margin-inline-start: auto;
}
</style>
