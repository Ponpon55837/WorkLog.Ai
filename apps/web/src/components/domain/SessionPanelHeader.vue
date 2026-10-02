<script setup lang="ts">
import { computed } from "vue";
import { Ban, ChevronDown, ChevronUp, FileDiff, FolderGit2, Link, Pencil, X } from "lucide-vue-next";
import type { SessionDetail } from "@work-intelligence/core";
import type { VoidTarget } from "../../composables/useRecordVoid";
import { verificationOf, verificationStatus } from "../../utils/status";
import UiIconButton from "../ui/UiIconButton.vue";
import UiLabel from "../ui/UiLabel.vue";
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
  <div class="session-panel__top">
    <span class="session-panel__eyebrow"
      >Session · <span class="mono">{{ session.id.slice(0, 8) }}</span></span
    >
    <div class="session-panel__actions">
      <UiIconButton
        :icon="ChevronUp"
        :label="t('上一筆 (K)')"
        size="sm"
        :disabled="position.index <= 0"
        @click="emit('previous')"
      />
      <UiIconButton
        :icon="ChevronDown"
        :label="t('下一筆 (J)')"
        size="sm"
        :disabled="position.index < 0 || position.index >= position.total - 1"
        @click="emit('next')"
      />
      <UiIconButton :icon="Pencil" :label="t('編輯 Session')" size="sm" @click="emit('edit', session)" />
      <UiIconButton
        v-if="!session.voided"
        :icon="Ban"
        :label="t('作廢 Session')"
        size="sm"
        @click="emit('voidRecord', sessionTarget)"
      />
      <UiIconButton :icon="Link" :label="t('複製連結')" size="sm" @click="emit('copyLink')" />
      <UiIconButton :icon="X" :label="t('關閉')" @click="emit('close')" />
    </div>
  </div>
  <h2 class="session-panel__title">{{ session.title }}</h2>
  <div class="session-panel__labels">
    <StatusLabel :status="verification" />
    <UiLabel :icon="FolderGit2">{{ detail.project.name }}</UiLabel>
    <UiLabel :icon="FileDiff">{{ t("{value} 個檔案", { value: session.changedFiles.length }) }}</UiLabel>
    <UiLabel v-if="session.voided" tone="danger" :icon="Ban">{{ t("已作廢") }}</UiLabel>
  </div>
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
</style>
