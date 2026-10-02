<script setup lang="ts">
import { computed } from "vue";
import { useRecordVoid } from "../../composables/useRecordVoid";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import UiField from "../ui/UiField.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiTextarea from "../ui/UiTextarea.vue";
import { t } from "../../i18n";

/**
 * Asks for the reason before voiding a Session or marking evidence as wrong. Voiding is a
 * reversible soft-delete: the record stays readable and every change is audited.
 */
const { voidTarget, voidReason, voidSaving, voidError, closeVoidDialog, submitVoid } = useRecordVoid();

const copy = {
  session: {
    title: t("session.voidSession"),
    action: t("common.void"),
    effect: t("session.onceVoidedThisSessionNo"),
  },
  evidence: {
    title: t("session.markEvidenceAsWrong"),
    action: t("session.markAsWrong"),
    effect: t("session.thisEvidenceStaysInThe"),
  },
  diagram: {
    title: t("session.voidDiagram"),
    action: t("common.void"),
    effect: t("session.theDiagramStaysInThe"),
  },
} as const;

const current = computed(() => copy[voidTarget.value?.type ?? "session"]);
</script>

<template>
  <UiDialog
    :open="Boolean(voidTarget)"
    :title="current.title"
    :description="voidTarget?.title"
    :busy="voidSaving"
    @close="closeVoidDialog"
  >
    <form id="record-void-form" class="record-void" @submit.prevent="submitVoid">
      <UiFlash v-if="voidError" tone="danger">{{ voidError }}</UiFlash>
      <p class="record-void__effect">{{ current.effect }}</p>
      <UiField :label="t('session.reasonLabel')" :hint="t('session.eGRecordedByMistake')"
        ><UiTextarea v-model="voidReason" :rows="3" :maxlength="1000" required autofocus
      /></UiField>
    </form>
    <template #footer>
      <UiButton :disabled="voidSaving" @click="closeVoidDialog">{{ t("common.cancel") }}</UiButton>
      <UiButton variant="danger" type="submit" form="record-void-form" :loading="voidSaving">{{
        current.action
      }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.record-void {
  display: grid;
  gap: var(--space-4);
}

.record-void__effect {
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--text-sm);
  line-height: 1.6;
}
</style>
