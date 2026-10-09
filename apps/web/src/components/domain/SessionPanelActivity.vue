<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import {
  Ban,
  BookOpen,
  FileDiff,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  History,
  Link2,
  Paperclip,
  Plus,
  RotateCcw,
  Unlink,
  Workflow,
} from "lucide-vue-next";
import type { EvidenceRecord, SessionDetail, SessionDiagramRecord, WorkSessionRecord } from "@work-intelligence/core";
import type { VoidTarget } from "../../composables/useRecordVoid";
import { commitUrl } from "../../utils/code-links";
import { formatDate, formatRelative } from "../../utils/format";
import { knowledgeKindLabels, sessionLinkDirectionLabels } from "../../utils/labels";
import { verificationStatus } from "../../utils/status";
import UiButton from "../ui/UiButton.vue";
import UiDisclosure from "../ui/UiDisclosure.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiLabel from "../ui/UiLabel.vue";
import VirtualList from "../VirtualList.vue";
import RelatedWorkBox from "./RelatedWorkBox.vue";
import ChangedFileList from "./ChangedFileList.vue";
import SessionDiagram from "./SessionDiagram.vue";
import { router } from "../../router";
import { t } from "../../i18n";

const props = defineProps<{ detail: SessionDetail }>();
const emit = defineEmits<{
  voidRecord: [target: VoidTarget];
  restoreRecord: [target: VoidTarget];
  addLink: [session: WorkSessionRecord];
  removeLink: [sessionId: string, relatedSessionId: string, title: string];
}>();

const route = useRoute();
const session = computed(() => props.detail.session);
const hasGit = computed(() => Boolean(session.value.commitSha || session.value.gitBranch));
const commitLink = computed(() =>
  props.detail.project.status === "tracked"
    ? commitUrl(props.detail.project.repositoryUrl, session.value.commitSha)
    : undefined,
);
const voidedEvidenceCount = computed(() => props.detail.evidence.filter((item) => item.voided).length);

function openDiagram(id: string): void {
  void router.replace({ query: { ...route.query, session: session.value.id, diagram: id } });
}

function diagramTarget(item: SessionDiagramRecord): VoidTarget {
  return { type: "diagram", id: item.id, sessionId: item.sessionId, title: item.title };
}

function evidenceTarget(item: EvidenceRecord): VoidTarget {
  return { type: "evidence", id: item.id, sessionId: item.sessionId, title: `${item.kind} · ${item.reference}` };
}

function verificationLabel(verification: { status: keyof typeof verificationStatus } | undefined): string {
  return verificationStatus[verification?.status ?? "not_supplied"].label;
}

function voidHistoryLabel(entry: { targetType: string; action: string }): string {
  const target = entry.targetType === "session" ? "Session" : "Evidence";
  return entry.action === "voided" ? t("session.voided", { target }) : t("session.restored", { target });
}

function decisionOriginLabel(origin: string): string {
  if (origin === "user_requested") return t("session.requestedByYou");
  if (origin === "agent_autonomous") return t("session.agentSOwnChoice");
  return t("session.sourceNotMarked");
}

function decisionStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: t("common.unconfirmed"),
    confirmed: t("common.confirmed"),
    rejected: t("common.rejected"),
    promoted: t("session.turnedIntoKnowledge"),
  };
  return labels[status] ?? status;
}

function decisionOriginTone(origin: string): "accent" | "attention" | "neutral" {
  if (origin === "user_requested") return "accent";
  return origin === "agent_autonomous" ? "attention" : "neutral";
}

function decisionStatusTone(status: string): "success" | "attention" | "danger" | "done" {
  if (status === "confirmed") return "success";
  if (status === "rejected") return "danger";
  if (status === "promoted") return "done";
  return "attention";
}
</script>

<template>
  <div class="session-panel__sections">
    <UiDisclosure :title="t('session.sectionChangedFiles')" :icon="FileDiff" :count="session.changedFiles.length" open>
      <ChangedFileList :session="session" :project="detail.project" />
    </UiDisclosure>
    <UiDisclosure
      v-if="hasGit"
      :title="t('session.sectionGit')"
      :icon="GitBranch"
      :hint="t('session.observedMetadata')"
    >
      <dl class="session-panel__meta session-panel__meta--inset">
        <template v-if="session.gitBranch"
          ><dt>Branch</dt>
          <dd class="mono">{{ session.gitBranch }}</dd></template
        >
        <template v-if="session.commitSha"
          ><dt>Commit</dt>
          <dd class="mono">
            <a
              v-if="commitLink"
              :href="commitLink"
              target="_blank"
              rel="noopener noreferrer"
              data-testid="commit-link"
              >{{ session.commitSha.slice(0, 12) }}</a
            ><template v-else>{{ session.commitSha.slice(0, 12) }}</template>
          </dd></template
        >
      </dl>
    </UiDisclosure>
    <UiDisclosure
      v-if="detail.diagrams.length"
      :title="t('common.diagram')"
      :icon="Workflow"
      :count="detail.diagrams.length"
      open
    >
      <div class="session-panel__diagrams">
        <div
          v-for="item in detail.diagrams"
          :key="item.id"
          :class="['session-panel__item', { 'is-voided': item.voided }]"
        >
          <div class="session-panel__item-head">
            <UiLabel v-if="item.voided" tone="danger" :icon="Ban">{{ t("session.voidedLabel") }}</UiLabel
            ><time :title="formatDate(item.createdAt)">{{ formatRelative(item.createdAt) }}</time>
            <UiIconButton
              v-if="item.voided"
              class="session-panel__item-action"
              :icon="RotateCcw"
              :label="t('session.restoreDiagram')"
              size="sm"
              @click="emit('restoreRecord', diagramTarget(item))"
            />
            <UiIconButton
              v-else
              class="session-panel__item-action"
              :icon="Ban"
              :label="t('session.voidDiagram')"
              size="sm"
              @click="emit('voidRecord', diagramTarget(item))"
            />
          </div>
          <template v-if="item.voided">
            <p class="session-panel__void-reason">
              {{ t("session.reason", { title: item.title, reason: item.voided.reason }) }}
            </p>
          </template>
          <SessionDiagram
            v-else
            :diagram="item"
            :project-root="detail.project.status === 'tracked' ? detail.project.rootPath : undefined"
            @expand="openDiagram(item.id)"
          />
        </div>
      </div>
    </UiDisclosure>
    <UiDisclosure
      v-if="detail.evidence.length"
      :title="t('session.sectionEvidence')"
      :icon="Paperclip"
      :count="detail.evidence.length"
      :hint="voidedEvidenceCount ? t('session.markedAsWrong', { voidedEvidenceCount }) : undefined"
    >
      <VirtualList
        :items="detail.evidence"
        :enabled="detail.evidence.length > 3"
        :estimate-item-height="112"
        max-height="min(38vh, 360px)"
        :label="t('session.sessionEvidenceList')"
      >
        <template #default="{ item }">
          <div :class="['session-panel__item', { 'is-voided': item.voided }]" data-testid="session-evidence">
            <div class="session-panel__item-head">
              <UiLabel>{{ item.kind }}</UiLabel
              ><UiLabel v-if="item.voided" tone="danger" :icon="Ban">{{ t("session.markedAsWrongLabel") }}</UiLabel
              ><time :title="formatDate(item.capturedAt)">{{ formatRelative(item.capturedAt) }}</time>
              <UiIconButton
                v-if="item.voided"
                class="session-panel__item-action"
                :icon="RotateCcw"
                :label="t('session.restoreEvidence')"
                size="sm"
                @click="emit('restoreRecord', evidenceTarget(item))"
              />
              <UiIconButton
                v-else
                class="session-panel__item-action"
                :icon="Ban"
                :label="t('session.markEvidenceAsWrong')"
                size="sm"
                @click="emit('voidRecord', evidenceTarget(item))"
              />
            </div>
            <p v-if="item.voided" class="session-panel__void-reason">
              {{ t("session.reasonValue", { reason: item.voided.reason }) }}
            </p>
            <p v-if="item.summary">{{ item.summary }}</p>
            <code>{{ item.reference }}</code>
          </div>
        </template>
      </VirtualList>
    </UiDisclosure>
    <UiDisclosure
      v-if="detail.decisions.length"
      :title="t('session.decisionsAndSources')"
      :count="detail.decisions.length"
    >
      <VirtualList
        :items="detail.decisions"
        :enabled="detail.decisions.length > 4"
        :estimate-item-height="96"
        max-height="min(38vh, 360px)"
        :label="t('session.sessionDecisionsAndSourcesList')"
      >
        <template #default="{ item }">
          <div class="session-panel__item" data-testid="session-decision">
            <div class="session-panel__item-head">
              <UiLabel :tone="decisionOriginTone(item.origin)">{{ decisionOriginLabel(item.origin) }}</UiLabel>
              <UiLabel :tone="decisionStatusTone(item.reviewStatus)">{{
                decisionStatusLabel(item.reviewStatus)
              }}</UiLabel>
            </div>
            <p>{{ item.text }}</p>
          </div>
        </template>
      </VirtualList>
    </UiDisclosure>
    <UiDisclosure
      v-if="detail.knowledge.length"
      :title="t('session.sectionKnowledge')"
      :icon="BookOpen"
      :count="detail.knowledge.length"
    >
      <VirtualList
        :items="detail.knowledge"
        :enabled="detail.knowledge.length > 2"
        :estimate-item-height="160"
        max-height="min(38vh, 360px)"
        :label="t('session.sessionKnowledgeList')"
      >
        <template #default="{ item }">
          <div class="session-panel__item">
            <div class="session-panel__item-head">
              <UiLabel tone="accent">{{ knowledgeKindLabels[item.kind] }}</UiLabel
              ><strong>{{ item.title }}</strong>
            </div>
            <p>{{ item.body }}</p>
          </div>
        </template>
      </VirtualList>
    </UiDisclosure>
    <UiDisclosure
      :title="t('session.linkedSessions')"
      :icon="Link2"
      :count="detail.links.length"
      :open="detail.links.length > 0"
      data-testid="session-links"
    >
      <VirtualList
        :items="detail.links"
        :enabled="detail.links.length > 4"
        :estimate-item-height="80"
        max-height="min(38vh, 360px)"
        :label="t('session.linkedSessionsList')"
      >
        <template #default="{ item: link }">
          <div class="session-panel__item">
            <div class="session-panel__item-head">
              <UiLabel :tone="link.relation === 'related' ? 'neutral' : 'accent'">{{
                sessionLinkDirectionLabels[link.relation]
              }}</UiLabel
              ><UiLabel v-if="link.voided" tone="danger" :icon="Ban">{{ t("session.voidedLabel") }}</UiLabel
              ><time :title="formatDate(link.completedAt)">{{ formatRelative(link.completedAt) }}</time>
              <UiIconButton
                class="session-panel__item-action"
                :icon="Unlink"
                :label="t('session.removeLink')"
                size="sm"
                @click="emit('removeLink', session.id, link.sessionId, link.title)"
              />
            </div>
            <RouterLink class="session-panel__link" :to="{ query: { ...route.query, session: link.sessionId } }">{{
              link.title
            }}</RouterLink>
          </div>
        </template>
      </VirtualList>
      <div class="session-panel__item session-panel__item--action">
        <UiButton size="sm" :icon="Plus" @click="emit('addLink', session)">{{ t("session.addLink") }}</UiButton>
      </div>
    </UiDisclosure>
    <UiDisclosure :title="t('session.sectionEvents')" :icon="GitCommitHorizontal" :count="detail.events.length">
      <VirtualList
        :items="detail.events"
        :enabled="detail.events.length > 5"
        :estimate-item-height="72"
        max-height="min(38vh, 360px)"
        :label="t('session.sessionEventsList')"
      >
        <template #default="{ item: event }">
          <div class="session-panel__event">
            <code>{{ event.type }}</code>
            <div>
              <span>{{ event.summary }}</span>
              <time :title="formatDate(event.occurredAt)">{{ formatRelative(event.occurredAt) }}</time>
            </div>
          </div>
        </template>
      </VirtualList>
    </UiDisclosure>
    <UiDisclosure v-if="detail.rawSnapshots.length" :title="t('session.sectionHandoffSnapshot')" :icon="FileText">
      <pre class="session-panel__snapshot">{{ detail.rawSnapshots[0]?.content }}</pre>
    </UiDisclosure>
    <UiDisclosure
      v-if="detail.verificationHistory.length"
      :title="t('session.verificationChangeHistory')"
      :icon="History"
      :count="detail.verificationHistory.length"
    >
      <VirtualList
        :items="detail.verificationHistory"
        :enabled="detail.verificationHistory.length > 4"
        :estimate-item-height="72"
        max-height="min(32vh, 320px)"
        :label="t('session.verificationChangeHistoryList')"
      >
        <template #default="{ item: entry }">
          <div class="session-panel__event">
            <code>{{ entry.source === "web" ? "Web UI" : "Agent" }}</code>
            <div>
              <span
                >{{ verificationLabel(entry.previous) }} → {{ verificationLabel(entry.resulting)
                }}<template v-if="entry.resulting.summary">{{
                  t("session.summarySuffix", { summary: entry.resulting.summary })
                }}</template></span
              >
              <time :title="formatDate(entry.createdAt)">{{ formatRelative(entry.createdAt) }}</time>
            </div>
          </div>
        </template>
      </VirtualList>
    </UiDisclosure>
    <UiDisclosure
      v-if="detail.voidHistory.length"
      :title="t('session.voidHistory')"
      :icon="History"
      :count="detail.voidHistory.length"
    >
      <VirtualList
        :items="detail.voidHistory"
        :enabled="detail.voidHistory.length > 4"
        :estimate-item-height="72"
        max-height="min(32vh, 320px)"
        :label="t('session.sessionVoidHistoryList')"
      >
        <template #default="{ item: entry }">
          <div class="session-panel__event">
            <code>{{ voidHistoryLabel(entry) }}</code>
            <div>
              <span>{{ entry.reason ?? t("session.noReasonGiven") }}</span>
              <time :title="formatDate(entry.occurredAt)">{{ formatRelative(entry.occurredAt) }}</time>
            </div>
          </div>
        </template>
      </VirtualList>
    </UiDisclosure>
    <RelatedWorkBox
      v-if="!session.voided && detail.project.status === 'tracked'"
      :key="session.id"
      :session-id="session.id"
    />
  </div>
</template>

<style scoped>
.session-panel__diagrams {
  display: grid;
  gap: var(--space-3);
}

.session-panel__sections {
  display: grid;
  gap: var(--space-2);
}

.session-panel__meta {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: var(--space-2) var(--space-4);
  margin: 0;
  font-size: var(--text-sm);
}

.session-panel__meta--inset {
  padding: var(--space-3);
}

.session-panel__meta dt {
  color: var(--fg-muted);
}

.session-panel__meta dd {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  margin: 0;
}

.session-panel__item {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--border-muted);
  font-size: var(--text-sm);
}

.session-panel__item:first-child {
  border-top: 0;
}

.session-panel__item-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.session-panel__item-head strong {
  color: var(--fg);
  font-size: var(--text-sm);
}

.session-panel__item--action {
  justify-items: start;
}

.session-panel__link {
  color: var(--fg);
  font-weight: 500;
  overflow-wrap: anywhere;
}

.session-panel__link:hover {
  color: var(--accent);
}

.session-panel__item-action {
  margin-left: auto;
}

.session-panel__item.is-voided code,
.session-panel__item.is-voided p:not(.session-panel__void-reason) {
  text-decoration: line-through;
}

.session-panel__void-reason {
  color: var(--danger);
}

.session-panel__item code {
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}

.session-panel__event {
  display: flex;
  gap: var(--space-3);
  padding: 6px var(--space-3);
  border-top: 1px solid var(--border-muted);
  font-size: var(--text-sm);
}

.session-panel__event:first-child {
  border-top: 0;
}

.session-panel__event code {
  flex: 0 0 90px;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}

.session-panel__event > div {
  display: grid;
  gap: 2px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.session-panel__event time {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.session-panel__snapshot {
  max-height: 320px;
  margin: 0;
  padding: var(--space-3);
  overflow: auto;
  color: var(--fg-muted);
  line-height: 1.6;
  white-space: pre-wrap;
}
</style>
