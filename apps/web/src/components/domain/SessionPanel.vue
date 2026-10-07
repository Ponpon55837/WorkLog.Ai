<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useRoute } from "vue-router";
import { useRecordVoid } from "../../composables/useRecordVoid";
import { useSessionEditor } from "../../composables/useSessionEditor";
import { useSessionLinks } from "../../composables/useSessionLinks";
import { useToast } from "../../composables/useToast";
import { router } from "../../router";
import { useSessionsStore } from "../../stores/sessions";
import { sessionMarkdown } from "../../utils/session-markdown";
import UiSidePanel from "../ui/UiSidePanel.vue";
import SessionPanelActivity from "./SessionPanelActivity.vue";
import SessionPanelHeader from "./SessionPanelHeader.vue";
import SessionPanelSummary from "./SessionPanelSummary.vue";
import { t } from "../../i18n";

/**
 * Session detail, mounted once in App. Opened from any list or via `?session=<id>`; J/K move
 * through the list it was opened from. The summary texts are edited through a separate Dialog.
 */
const route = useRoute();
const sessionsStore = useSessionsStore();
const { selectedDetail, position } = storeToRefs(sessionsStore);
const { openSessionDetail, closeSessionDetail, openAdjacentSession } = sessionsStore;
const { openSessionEditor } = useSessionEditor();
const { openVoidDialog, restoreRecord } = useRecordVoid();
const { openLinkDialog, removeLink } = useSessionLinks();

const body = ref<HTMLElement | null>(null);

const session = computed(() => selectedDetail.value?.session);

function copyLink(): void {
  void useToast().copyWithToast(window.location.href, t("session.sessionLinkCopied"));
}

function copyMarkdown(): void {
  if (!selectedDetail.value) return;
  void useToast().copyWithToast(sessionMarkdown(selectedDetail.value), t("session.markdownCopied"));
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

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <UiSidePanel
    :open="Boolean(selectedDetail)"
    :label="t('session.sessionDetails')"
    :width="760"
    storage-key="session"
    @close="closeSessionDetail"
  >
    <template v-if="selectedDetail && session" #header>
      <SessionPanelHeader
        :detail="selectedDetail"
        :position="position"
        @previous="openAdjacentSession(-1)"
        @next="openAdjacentSession(1)"
        @edit="openSessionEditor"
        @void-record="openVoidDialog"
        @copy-link="copyLink"
        @copy-markdown="copyMarkdown"
        @close="closeSessionDetail"
      />
    </template>

    <div v-if="selectedDetail && session" ref="body" class="session-panel">
      <SessionPanelSummary :detail="selectedDetail" @restore-record="restoreRecord" />
      <SessionPanelActivity
        :detail="selectedDetail"
        @void-record="openVoidDialog"
        @restore-record="restoreRecord"
        @add-link="openLinkDialog"
        @remove-link="removeLink"
      />
    </div>

    <template #footer>
      <div class="session-panel__footer">
        <span><kbd>J</kbd> / <kbd>K</kbd> {{ t("session.previousNext") }} <kbd>Esc</kbd> {{ t("common.close") }}</span>
        <span v-if="position.index >= 0">{{ position.index + 1 }} / {{ position.total }}</span>
      </div>
    </template>
  </UiSidePanel>
</template>

<style scoped>
.session-panel {
  display: grid;
  gap: var(--space-6);
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
</style>
