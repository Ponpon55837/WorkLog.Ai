<script setup lang="ts">
import { computed } from "vue";
import { Ban, ChevronDown, ChevronUp, ClipboardCopy, FileDiff, FolderGit2, Link, Pencil } from "lucide-vue-next";
import type { SessionDetail } from "@work-intelligence/core";
import type { VoidTarget } from "../../composables/useRecordVoid";
import { verificationOf, verificationStatus } from "../../utils/status";
import UiIconButton from "../ui/UiIconButton.vue";
import UiLabel from "../ui/UiLabel.vue";
import UiSidePanelHeader from "../ui/UiSidePanelHeader.vue";
import StatusLabel from "./StatusLabel.vue";
import { t } from "../../i18n";

const props = defineProps<{
  detail: SessionDetail;
  position: { index: number; total: number };
}>();

const emit = defineEmits<{
  previous: [];
  next: [];
  edit: [session: SessionDetail["session"]];
  voidRecord: [target: VoidTarget];
  copyLink: [];
  copyMarkdown: [];
  close: [];
}>();

const session = computed(() => props.detail.session);
const verification = computed(() => verificationStatus[verificationOf(session.value)]);
const sessionTarget = computed<VoidTarget>(() => ({
  type: "session",
  id: session.value.id,
  sessionId: session.value.id,
  title: session.value.title,
}));
</script>

<template>
  <UiSidePanelHeader :title="session.title" :close-label="t('common.close')" @close="emit('close')">
    <template #actions>
      <UiIconButton
        :icon="ChevronUp"
        :label="t('session.previousK')"
        size="sm"
        :disabled="position.index <= 0"
        @click="emit('previous')"
      />
      <UiIconButton
        :icon="ChevronDown"
        :label="t('session.nextJ')"
        size="sm"
        :disabled="position.index < 0 || position.index >= position.total - 1"
        @click="emit('next')"
      />
      <UiIconButton :icon="Pencil" :label="t('session.editSession')" size="sm" @click="emit('edit', session)" />
      <UiIconButton
        v-if="!session.voided"
        :icon="Ban"
        :label="t('session.voidSession')"
        size="sm"
        @click="emit('voidRecord', sessionTarget)"
      />
      <UiIconButton :icon="Link" :label="t('session.copyLink')" size="sm" @click="emit('copyLink')" />
      <UiIconButton :icon="ClipboardCopy" :label="t('session.copyMarkdown')" size="sm" @click="emit('copyMarkdown')" />
    </template>
    <div class="session-panel__labels">
      <StatusLabel :status="verification" />
      <UiLabel class="mono">{{ session.id.slice(0, 8) }}</UiLabel>
      <UiLabel :icon="FolderGit2">{{ detail.project.name }}</UiLabel>
      <UiLabel :icon="FileDiff">{{ t("common.files", { value: session.changedFiles.length }) }}</UiLabel>
      <UiLabel v-if="session.voided" tone="danger" :icon="Ban">{{ t("session.voidedLabel") }}</UiLabel>
    </div>
  </UiSidePanelHeader>
</template>

<style scoped>
.session-panel__labels {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
</style>
