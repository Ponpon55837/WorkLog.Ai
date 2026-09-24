<script setup lang="ts">
import { onBeforeUnmount, watch } from "vue";
import { Search } from "lucide-vue-next";
import { useSessionLinks } from "../../composables/useSessionLinks";
import { formatRelative } from "../../utils/format";
import { sessionLinkOptions } from "../../utils/labels";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import UiEmptyState from "../ui/UiEmptyState.vue";
import UiField from "../ui/UiField.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiSelect from "../ui/UiSelect.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import UiTextInput from "../ui/UiTextInput.vue";

/** Links the open Session to another one (planning ↔ implementation, follow-ups) so recall finds both. */
const {
  linkSource,
  linkQuery,
  linkCandidates,
  linkCandidatesLoading,
  linkTargetId,
  linkDirection,
  linkSaving,
  linkError,
  closeLinkDialog,
  searchLinkCandidates,
  saveLink,
} = useSessionLinks();

let timer: number | undefined;
watch(linkQuery, () => {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void searchLinkCandidates(), 300);
});
onBeforeUnmount(() => window.clearTimeout(timer));
</script>

<template>
  <UiDialog
    :open="Boolean(linkSource)"
    title="新增 Session 關聯"
    :description="linkSource?.title"
    :busy="linkSaving"
    @close="closeLinkDialog"
  >
    <form id="session-link-form" class="session-link" @submit.prevent="saveLink">
      <UiFlash v-if="linkError" tone="danger">{{ linkError }}</UiFlash>
      <UiTextInput
        v-model="linkQuery"
        type="search"
        :icon="Search"
        label="搜尋要關聯的 Session"
        placeholder="搜尋 title、summary 或 event"
        autofocus
      />
      <UiSkeleton v-if="linkCandidatesLoading && linkCandidates.length === 0" :count="3" />
      <UiEmptyState
        v-else-if="linkCandidates.length === 0"
        compact
        title="沒有符合的 Session"
        description="換個關鍵字再試一次。"
      />
      <fieldset v-else class="session-link__candidates">
        <legend class="session-link__legend">選擇 Session</legend>
        <label v-for="candidate in linkCandidates" :key="candidate.id" class="session-link__candidate">
          <input v-model="linkTargetId" type="radio" name="link-target" :value="candidate.id" />
          <span class="session-link__candidate-text">
            <strong>{{ candidate.title }}</strong>
            <span>{{ candidate.projectName }} · {{ formatRelative(candidate.completedAt) }}</span>
          </span>
        </label>
      </fieldset>
      <UiField label="關係"><UiSelect v-model="linkDirection" label="關係" :options="sessionLinkOptions" /></UiField>
    </form>
    <template #footer>
      <UiButton :disabled="linkSaving" @click="closeLinkDialog">取消</UiButton>
      <UiButton variant="primary" type="submit" form="session-link-form" :loading="linkSaving">建立關聯</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.session-link {
  display: grid;
  gap: var(--space-4);
}

.session-link__candidates {
  display: grid;
  max-height: 280px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.session-link__legend {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

.session-link__candidate {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--border-muted);
  cursor: pointer;
}

.session-link__candidate:first-of-type {
  border-top: 0;
}

.session-link__candidate:hover,
.session-link__candidate:has(input:checked) {
  background: var(--bg-subtle);
}

.session-link__candidate input {
  margin-top: 3px;
  accent-color: var(--accent);
}

.session-link__candidate-text {
  display: grid;
  gap: 2px;
  min-width: 0;
  font-size: var(--text-sm);
}

.session-link__candidate-text strong {
  color: var(--fg);
  font-weight: 500;
  overflow-wrap: anywhere;
}

.session-link__candidate-text span {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}
</style>
