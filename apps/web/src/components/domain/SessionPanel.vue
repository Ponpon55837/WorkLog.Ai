<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import {
  Ban,
  BookOpen,
  ChevronDown,
  ChevronUp,
  FileDiff,
  FileText,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  History,
  Link,
  Link2,
  Plus,
  Unlink,
  Paperclip,
  Pencil,
  RotateCcw,
  X,
} from "lucide-vue-next";
import type { EvidenceRecord } from "@work-intelligence/core";
import { useSessionDetail } from "../../composables/useSessionDetail";
import { useRecordVoid, type VoidTarget } from "../../composables/useRecordVoid";
import { useSessionEditor } from "../../composables/useSessionEditor";
import { useSessionLinks } from "../../composables/useSessionLinks";
import { useToast } from "../../composables/useToast";
import { router } from "../../router";
import {
  formatDate,
  formatDuration,
  formatReadableSummary,
  formatRelative,
  wasUpdatedAfterFinalize,
} from "../../utils/format";
import { knowledgeKindLabels, sessionLinkDirectionLabels } from "../../utils/labels";
import { executionStatusVisual, verificationOf, verificationStatus } from "../../utils/status";
import UiButton from "../ui/UiButton.vue";
import UiDisclosure from "../ui/UiDisclosure.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiSidePanel from "../ui/UiSidePanel.vue";
import VirtualList from "../VirtualList.vue";
import ChangedFileList from "./ChangedFileList.vue";
import StatusLabel from "./StatusLabel.vue";
import WorkSummarySections from "./WorkSummarySections.vue";

/**
 * Session detail, mounted once in App. Opened from any list or via `?session=<id>`; J/K move
 * through the list it was opened from. The summary texts are edited through a separate Dialog.
 */
const route = useRoute();
const { selectedDetail, position, openSessionDetail, closeSessionDetail, openAdjacentSession } = useSessionDetail();
const { openSessionEditor } = useSessionEditor();
const { openVoidDialog, restoreRecord } = useRecordVoid();
const { openLinkDialog, removeLink } = useSessionLinks();
const body = ref<HTMLElement | null>(null);

const session = computed(() => selectedDetail.value?.session);
const verification = computed(() => (session.value ? verificationStatus[verificationOf(session.value)] : undefined));
const hasGit = computed(() => Boolean(session.value?.commitSha || session.value?.gitBranch));
const sessionTarget = computed<VoidTarget | undefined>(() =>
  session.value
    ? { type: "session", id: session.value.id, sessionId: session.value.id, title: session.value.title }
    : undefined,
);
const voidedEvidenceCount = computed(() => selectedDetail.value?.evidence.filter((item) => item.voided).length ?? 0);

function evidenceTarget(item: EvidenceRecord): VoidTarget {
  return { type: "evidence", id: item.id, sessionId: item.sessionId, title: `${item.kind} · ${item.reference}` };
}

function verificationLabel(verification: { status: keyof typeof verificationStatus } | undefined): string {
  return verificationStatus[verification?.status ?? "not_supplied"].label;
}

function voidHistoryLabel(entry: { targetType: string; action: string }): string {
  const target = entry.targetType === "session" ? "Session" : "Evidence";
  return entry.action === "voided" ? `${target} 作廢` : `${target} 還原`;
}

watch(
  () => route.query.session,
  (id) => {
    if (typeof id === "string" && id !== session.value?.id) {
      void openSessionDetail(id);
    } else if (!id && session.value) {
      closeSessionDetail();
    }
  },
  { immediate: true },
);

watch(
  () => session.value?.id,
  async (id) => {
    if ((route.query.session ?? undefined) !== id) {
      const query = { ...route.query };
      if (id) {
        query.session = id;
      } else {
        delete query.session;
      }
      void router.replace({ query });
    }
    await nextTick();
    body.value?.closest(".ui-side-panel__body")?.scrollTo({ top: 0 });
  },
);

function copyLink(): void {
  void useToast().copyWithToast(window.location.href, "已複製 Session 連結。");
}

function onKeydown(event: KeyboardEvent): void {
  if (!session.value || event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, select, [contenteditable='true']")) {
    return;
  }
  if (event.key === "j") {
    openAdjacentSession(1);
  } else if (event.key === "k") {
    openAdjacentSession(-1);
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <UiSidePanel
    :open="Boolean(selectedDetail)"
    label="Session 詳情"
    :width="760"
    storage-key="session"
    @close="closeSessionDetail"
  >
    <template v-if="selectedDetail && session" #header>
      <div class="session-panel__top">
        <span class="session-panel__eyebrow"
          >Session · <span class="mono">{{ session.id.slice(0, 8) }}</span></span
        >
        <div class="session-panel__actions">
          <UiIconButton
            :icon="ChevronUp"
            label="上一筆 (K)"
            size="sm"
            :disabled="position.index <= 0"
            @click="openAdjacentSession(-1)"
          />
          <UiIconButton
            :icon="ChevronDown"
            label="下一筆 (J)"
            size="sm"
            :disabled="position.index < 0 || position.index >= position.total - 1"
            @click="openAdjacentSession(1)"
          />
          <UiIconButton :icon="Pencil" label="編輯 Session" size="sm" @click="openSessionEditor(session)" />
          <UiIconButton
            v-if="!session.voided && sessionTarget"
            :icon="Ban"
            label="作廢 Session"
            size="sm"
            @click="openVoidDialog(sessionTarget)"
          />
          <UiIconButton :icon="Link" label="複製連結" size="sm" @click="copyLink" />
          <UiIconButton :icon="X" label="關閉" @click="closeSessionDetail" />
        </div>
      </div>
      <h2 class="session-panel__title">{{ session.title }}</h2>
      <div class="session-panel__labels">
        <StatusLabel v-if="verification" :status="verification" />
        <UiLabel :icon="FolderGit2">{{ selectedDetail.project.name }}</UiLabel>
        <UiLabel :icon="FileDiff">{{ session.changedFiles.length }} files</UiLabel>
        <UiLabel v-if="session.voided" tone="danger" :icon="Ban">已作廢</UiLabel>
      </div>
    </template>

    <div v-if="selectedDetail && session" ref="body" class="session-panel">
      <UiFlash v-if="session.voided && sessionTarget" tone="attention" title="這筆 Session 已作廢">
        {{ session.voided.reason }}（{{ formatDate(session.voided.at) }}）。不會出現在工作歷程、報告、圖譜與 Agent
        檢索。
        <template #actions
          ><UiButton size="sm" :icon="RotateCcw" @click="restoreRecord(sessionTarget)">還原</UiButton></template
        >
      </UiFlash>
      <p class="session-panel__summary">{{ formatReadableSummary(session.summary) }}</p>

      <dl class="session-panel__meta">
        <dt>專案</dt>
        <dd>
          <span>{{ selectedDetail.project.name }}</span>
          <code class="session-panel__path">{{ selectedDetail.project.rootPath }}</code>
        </dd>
        <dt>開始時間</dt>
        <dd>
          <template v-if="session.startedAt">
            <time :datetime="session.startedAt">{{ formatDate(session.startedAt) }}</time>
            <span class="session-panel__muted">耗時 {{ formatDuration(session.startedAt, session.completedAt) }}</span>
          </template>
          <span v-else class="session-panel__muted">未回報</span>
        </dd>
        <dt>完成時間</dt>
        <dd>
          <time :datetime="session.completedAt"
            >{{ formatDate(session.completedAt) }}（{{ formatRelative(session.completedAt) }}）</time
          >
        </dd>
        <dt>最後更新</dt>
        <dd>
          <time v-if="wasUpdatedAfterFinalize(session)" :datetime="session.updatedAt"
            >{{ formatDate(session.updatedAt) }}（{{ formatRelative(session.updatedAt) }}）</time
          >
          <span v-else class="session-panel__muted">完成後未修改</span>
        </dd>
        <dt>執行狀態</dt>
        <dd><StatusLabel :status="executionStatusVisual" /></dd>
        <dt>Verification</dt>
        <dd>
          <StatusLabel v-if="verification" :status="verification" />
          <span v-if="session.verification?.summary" class="session-panel__muted">{{
            session.verification.summary
          }}</span>
        </dd>
      </dl>

      <WorkSummarySections :summary="session.workSummary" />

      <div class="session-panel__sections">
        <UiDisclosure title="Changed files" :icon="FileDiff" :count="session.changedFiles.length" open>
          <ChangedFileList :session="session" />
        </UiDisclosure>
        <UiDisclosure v-if="hasGit" title="Git" :icon="GitBranch" hint="observed metadata">
          <dl class="session-panel__meta session-panel__meta--inset">
            <template v-if="session.gitBranch"
              ><dt>Branch</dt>
              <dd class="mono">{{ session.gitBranch }}</dd></template
            >
            <template v-if="session.commitSha"
              ><dt>Commit</dt>
              <dd class="mono">{{ session.commitSha.slice(0, 12) }}</dd></template
            >
          </dl>
        </UiDisclosure>
        <UiDisclosure
          v-if="selectedDetail.evidence.length"
          title="Evidence"
          :icon="Paperclip"
          :count="selectedDetail.evidence.length"
          :hint="voidedEvidenceCount ? `${voidedEvidenceCount} 筆已標示錯誤` : undefined"
        >
          <VirtualList
            :items="selectedDetail.evidence"
            :enabled="selectedDetail.evidence.length > 5"
            :estimate-item-height="112"
            max-height="min(38vh, 360px)"
            label="Session Evidence 清單"
          >
            <template #default="{ item }">
              <div :class="['session-panel__item', { 'is-voided': item.voided }]" data-testid="session-evidence">
                <div class="session-panel__item-head">
                  <UiLabel>{{ item.kind }}</UiLabel
                  ><UiLabel v-if="item.voided" tone="danger" :icon="Ban">已標示錯誤</UiLabel
                  ><time :title="formatDate(item.capturedAt)">{{ formatRelative(item.capturedAt) }}</time>
                  <UiIconButton
                    v-if="item.voided"
                    class="session-panel__item-action"
                    :icon="RotateCcw"
                    label="還原 Evidence"
                    size="sm"
                    @click="restoreRecord(evidenceTarget(item))"
                  />
                  <UiIconButton
                    v-else
                    class="session-panel__item-action"
                    :icon="Ban"
                    label="標示 Evidence 為錯誤"
                    size="sm"
                    @click="openVoidDialog(evidenceTarget(item))"
                  />
                </div>
                <p v-if="item.voided" class="session-panel__void-reason">原因：{{ item.voided.reason }}</p>
                <p v-if="item.summary">{{ item.summary }}</p>
                <code>{{ item.reference }}</code>
              </div>
            </template>
          </VirtualList>
        </UiDisclosure>
        <UiDisclosure
          v-if="selectedDetail.knowledge.length"
          title="Knowledge"
          :icon="BookOpen"
          :count="selectedDetail.knowledge.length"
        >
          <VirtualList
            :items="selectedDetail.knowledge"
            :enabled="selectedDetail.knowledge.length > 5"
            :estimate-item-height="160"
            max-height="min(38vh, 360px)"
            label="Session Knowledge 清單"
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
          title="關聯 Session"
          :icon="Link2"
          :count="selectedDetail.links.length"
          :open="selectedDetail.links.length > 0"
          data-testid="session-links"
        >
          <VirtualList
            :items="selectedDetail.links"
            :enabled="selectedDetail.links.length > 5"
            :estimate-item-height="80"
            max-height="min(38vh, 360px)"
            label="關聯 Session 清單"
          >
            <template #default="{ item: link }">
              <div class="session-panel__item">
                <div class="session-panel__item-head">
                  <UiLabel :tone="link.relation === 'related' ? 'neutral' : 'accent'">{{
                    sessionLinkDirectionLabels[link.relation]
                  }}</UiLabel
                  ><UiLabel v-if="link.voided" tone="danger" :icon="Ban">已作廢</UiLabel
                  ><time :title="formatDate(link.completedAt)">{{ formatRelative(link.completedAt) }}</time>
                  <UiIconButton
                    class="session-panel__item-action"
                    :icon="Unlink"
                    label="移除關聯"
                    size="sm"
                    @click="removeLink(session.id, link.sessionId, link.title)"
                  />
                </div>
                <RouterLink class="session-panel__link" :to="{ query: { ...route.query, session: link.sessionId } }">{{
                  link.title
                }}</RouterLink>
              </div>
            </template>
          </VirtualList>
          <div class="session-panel__item session-panel__item--action">
            <UiButton size="sm" :icon="Plus" @click="openLinkDialog(session)">新增關聯</UiButton>
          </div>
        </UiDisclosure>
        <UiDisclosure title="Events" :icon="GitCommitHorizontal" :count="selectedDetail.events.length">
          <VirtualList
            :items="selectedDetail.events"
            :enabled="selectedDetail.events.length > 5"
            :estimate-item-height="72"
            max-height="min(38vh, 360px)"
            label="Session Events 清單"
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
        <UiDisclosure v-if="selectedDetail.rawSnapshots.length" title="Handoff snapshot" :icon="FileText">
          <pre class="session-panel__snapshot">{{ selectedDetail.rawSnapshots[0]?.content }}</pre>
        </UiDisclosure>
        <UiDisclosure
          v-if="selectedDetail.verificationHistory.length"
          title="Verification 修改紀錄"
          :icon="History"
          :count="selectedDetail.verificationHistory.length"
        >
          <VirtualList
            :items="selectedDetail.verificationHistory"
            :enabled="selectedDetail.verificationHistory.length > 5"
            :estimate-item-height="72"
            max-height="min(32vh, 320px)"
            label="Verification 修改紀錄清單"
          >
            <template #default="{ item: entry }">
              <div class="session-panel__event">
                <code>{{ entry.source === "web" ? "Web UI" : "Agent" }}</code>
                <div>
                  <span
                    >{{ verificationLabel(entry.previous) }} → {{ verificationLabel(entry.resulting)
                    }}<template v-if="entry.resulting.summary">：{{ entry.resulting.summary }}</template></span
                  >
                  <time :title="formatDate(entry.createdAt)">{{ formatRelative(entry.createdAt) }}</time>
                </div>
              </div>
            </template>
          </VirtualList>
        </UiDisclosure>
        <UiDisclosure
          v-if="selectedDetail.voidHistory.length"
          title="作廢紀錄"
          :icon="History"
          :count="selectedDetail.voidHistory.length"
        >
          <VirtualList
            :items="selectedDetail.voidHistory"
            :enabled="selectedDetail.voidHistory.length > 5"
            :estimate-item-height="72"
            max-height="min(32vh, 320px)"
            label="Session 作廢紀錄清單"
          >
            <template #default="{ item: entry }">
              <div class="session-panel__event">
                <code>{{ voidHistoryLabel(entry) }}</code>
                <div>
                  <span>{{ entry.reason ?? "未填原因" }}</span>
                  <time :title="formatDate(entry.occurredAt)">{{ formatRelative(entry.occurredAt) }}</time>
                </div>
              </div>
            </template>
          </VirtualList>
        </UiDisclosure>
      </div>
    </div>

    <template #footer>
      <div class="session-panel__footer">
        <span><kbd>J</kbd> / <kbd>K</kbd> 切換上下筆 · <kbd>Esc</kbd> 關閉</span>
        <span v-if="position.index >= 0">{{ position.index + 1 }} / {{ position.total }}</span>
      </div>
    </template>
  </UiSidePanel>
</template>

<style scoped>
.session-panel__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.session-panel__eyebrow {
  color: var(--fg-muted);
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.session-panel__actions {
  display: flex;
  gap: var(--space-1);
}

.session-panel__title {
  margin: var(--space-2) 0;
  color: var(--fg);
  font-size: var(--text-xl);
  font-weight: 600;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.session-panel__labels {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.session-panel {
  display: grid;
  gap: var(--space-6);
}

.session-panel__summary {
  color: var(--fg);
  font-size: var(--text-lg);
  line-height: 1.6;
  white-space: pre-line;
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

.session-panel__path {
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}

.session-panel__muted {
  color: var(--fg-muted);
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

.session-panel__footer {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
}

kbd {
  padding: 0 5px;
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--bg-subtle);
  font-size: 11px;
}

@media (max-width: 639px) {
  .session-panel__meta {
    grid-template-columns: 1fr;
    gap: 2px;
  }

  .session-panel__meta dd {
    margin-bottom: var(--space-2);
  }
}
</style>
