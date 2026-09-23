<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { BookOpen, ChevronDown, ChevronUp, FileDiff, FileText, FolderGit2, GitBranch, GitCommitHorizontal, Link, Paperclip, X } from "lucide-vue-next";
import { useSessionDetail } from "../../composables/useSessionDetail";
import { useToast } from "../../composables/useToast";
import { router } from "../../router";
import { formatDate, formatReadableSummary, formatRelative } from "../../utils/format";
import { knowledgeKindLabels } from "../../utils/labels";
import { executionStatusVisual, verificationOf, verificationStatus } from "../../utils/status";
import UiDisclosure from "../ui/UiDisclosure.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiSidePanel from "../ui/UiSidePanel.vue";
import ChangedFileList from "./ChangedFileList.vue";
import StatusLabel from "./StatusLabel.vue";
import WorkSummarySections from "./WorkSummarySections.vue";

/**
 * Read-only Session detail, mounted once in App. Opened from any list or via `?session=<id>`;
 * J/K move through the list it was opened from.
 */
const route = useRoute();
const { selectedDetail, position, openSessionDetail, closeSessionDetail, openAdjacentSession } = useSessionDetail();
const body = ref<HTMLElement | null>(null);

const session = computed(() => selectedDetail.value?.session);
const verification = computed(() => (session.value ? verificationStatus[verificationOf(session.value)] : undefined));
const hasGit = computed(() => Boolean(session.value?.commitSha || session.value?.gitBranch));

watch(() => route.query.session, (id) => {
  if (typeof id === "string" && id !== session.value?.id) {
    void openSessionDetail(id);
  } else if (!id && session.value) {
    closeSessionDetail();
  }
}, { immediate: true });

watch(() => session.value?.id, async (id) => {
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
});

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
  <UiSidePanel :open="Boolean(selectedDetail)" label="Session 詳情" @close="closeSessionDetail">
    <template v-if="selectedDetail && session" #header>
      <div class="session-panel__top">
        <span class="session-panel__eyebrow">Session · <span class="mono">{{ session.id.slice(0, 8) }}</span></span>
        <div class="session-panel__actions">
          <UiIconButton :icon="ChevronUp" label="上一筆 (K)" size="sm" :disabled="position.index <= 0" @click="openAdjacentSession(-1)" />
          <UiIconButton :icon="ChevronDown" label="下一筆 (J)" size="sm" :disabled="position.index < 0 || position.index >= position.total - 1" @click="openAdjacentSession(1)" />
          <UiIconButton :icon="Link" label="複製連結" size="sm" @click="copyLink" />
          <UiIconButton :icon="X" label="關閉" @click="closeSessionDetail" />
        </div>
      </div>
      <h2 class="session-panel__title">{{ session.title }}</h2>
      <div class="session-panel__labels">
        <StatusLabel v-if="verification" :status="verification" />
        <UiLabel :icon="FolderGit2">{{ selectedDetail.project.name }}</UiLabel>
        <UiLabel :icon="FileDiff">{{ session.changedFiles.length }} files</UiLabel>
      </div>
    </template>

    <div v-if="selectedDetail && session" ref="body" class="session-panel">
      <p class="session-panel__summary">{{ formatReadableSummary(session.summary) }}</p>

      <dl class="session-panel__meta">
        <dt>專案</dt>
        <dd><span>{{ selectedDetail.project.name }}</span> <code class="session-panel__path">{{ selectedDetail.project.rootPath }}</code></dd>
        <dt>完成時間</dt>
        <dd><time :datetime="session.completedAt">{{ formatDate(session.completedAt) }}（{{ formatRelative(session.completedAt) }}）</time></dd>
        <dt>執行狀態</dt>
        <dd><StatusLabel :status="executionStatusVisual" /></dd>
        <dt>Verification</dt>
        <dd>
          <StatusLabel v-if="verification" :status="verification" />
          <span v-if="session.verification?.summary" class="session-panel__muted">{{ session.verification.summary }}</span>
        </dd>
      </dl>

      <WorkSummarySections :summary="session.workSummary" />

      <div class="session-panel__sections">
        <UiDisclosure title="Changed files" :icon="FileDiff" :count="session.changedFiles.length" open>
          <ChangedFileList :session="session" />
        </UiDisclosure>
        <UiDisclosure v-if="hasGit" title="Git" :icon="GitBranch" hint="observed metadata">
          <dl class="session-panel__meta session-panel__meta--inset">
            <template v-if="session.gitBranch"><dt>Branch</dt><dd class="mono">{{ session.gitBranch }}</dd></template>
            <template v-if="session.commitSha"><dt>Commit</dt><dd class="mono">{{ session.commitSha.slice(0, 12) }}</dd></template>
          </dl>
        </UiDisclosure>
        <UiDisclosure v-if="selectedDetail.evidence.length" title="Evidence" :icon="Paperclip" :count="selectedDetail.evidence.length">
          <div v-for="item in selectedDetail.evidence" :key="item.id" class="session-panel__item">
            <div class="session-panel__item-head"><UiLabel>{{ item.kind }}</UiLabel><time :title="formatDate(item.capturedAt)">{{ formatRelative(item.capturedAt) }}</time></div>
            <p v-if="item.summary">{{ item.summary }}</p>
            <code>{{ item.reference }}</code>
          </div>
        </UiDisclosure>
        <UiDisclosure v-if="selectedDetail.knowledge.length" title="Knowledge" :icon="BookOpen" :count="selectedDetail.knowledge.length">
          <div v-for="item in selectedDetail.knowledge" :key="item.id" class="session-panel__item">
            <div class="session-panel__item-head"><UiLabel tone="accent">{{ knowledgeKindLabels[item.kind] }}</UiLabel><strong>{{ item.title }}</strong></div>
            <p>{{ item.body }}</p>
          </div>
        </UiDisclosure>
        <UiDisclosure title="Events" :icon="GitCommitHorizontal" :count="selectedDetail.events.length">
          <ol class="session-panel__events">
            <li v-for="event in selectedDetail.events" :key="event.id">
              <code>{{ event.type }}</code>
              <div>
                <span>{{ event.summary }}</span>
                <time :title="formatDate(event.occurredAt)">{{ formatRelative(event.occurredAt) }}</time>
              </div>
            </li>
          </ol>
        </UiDisclosure>
        <UiDisclosure v-if="selectedDetail.rawSnapshots.length" title="Handoff snapshot" :icon="FileText">
          <pre class="session-panel__snapshot">{{ selectedDetail.rawSnapshots[0]?.content }}</pre>
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

.session-panel__item code {
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}

.session-panel__events {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  list-style: none;
}

.session-panel__events li {
  display: flex;
  gap: var(--space-3);
  padding: 6px 0;
  font-size: var(--text-sm);
}

.session-panel__events code {
  flex: 0 0 90px;
  color: var(--fg-muted);
}

.session-panel__events div {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.session-panel__events time {
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
