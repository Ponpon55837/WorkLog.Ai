<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, ref } from "vue";
import {
  cloneReportPresentationState,
  type ReportPresentation,
  type ReportPresentationState,
  type ReportSectionKey,
  type ReportSummary,
} from "@work-intelligence/core";
import { ApiError } from "../../api/client";
import { confirmAction } from "../../composables/useConfirm";
import { useToast } from "../../composables/useToast";
import { useReportPresentationStore } from "../../stores/report-presentation";
import { errorMessage } from "../../utils/format";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import UiField from "../ui/UiField.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiTextInput from "../ui/UiTextInput.vue";
import UiTextarea from "../ui/UiTextarea.vue";
import { t } from "../../i18n";

type Target = { summary: ReportSummary; section: ReportSectionKey; ordinal: number };
const props = defineProps<{ displayedSummaryId: string }>();
const emit = defineEmits<{ openSources: [sessionIds: string[]] }>();
const presentation = useReportPresentationStore();
const { saving } = storeToRefs(presentation);
const { showToast } = useToast();
const target = ref<Target | null>(null);
const baseState = ref<ReportPresentationState>({ pinned: [], hidden: [], overrides: [] });
const revision = ref(0);
const title = ref("");
const detail = ref("");
const initialTitle = ref("");
const initialDetail = ref("");
const error = ref("");
const conflict = ref(false);
const latest = ref<ReportPresentation | null>(null);
const comparing = ref(false);
const original = computed(() =>
  target.value ? target.value.summary[target.value.section][target.value.ordinal] : null,
);
const dirty = computed(() => title.value !== initialTitle.value || detail.value !== initialDetail.value);
const manualLength = computed(
  () =>
    baseState.value.overrides
      .filter((item) => item.section !== target.value?.section || item.ordinal !== target.value?.ordinal)
      .reduce((n, item) => n + item.title.length + item.detail.length, 0) +
    title.value.trim().length +
    detail.value.trim().length,
);
const invalid = computed(
  () =>
    !title.value.trim() ||
    !detail.value.trim() ||
    title.value.length > 300 ||
    detail.value.length > 4000 ||
    manualLength.value > 8000,
);
const latestBlock = computed(
  () =>
    latest.value?.state.overrides.find(
      (item) => item.section === target.value?.section && item.ordinal === target.value?.ordinal,
    ) ?? original.value,
);

function open(summary: ReportSummary, section: ReportSectionKey, ordinal: number, current: ReportPresentation): void {
  const block = summary[section][ordinal];
  if (!block) return;
  target.value = { summary, section, ordinal };
  baseState.value = cloneReportPresentationState(current.state);
  revision.value = current.revision;
  const override = current.state.overrides.find((item) => item.section === section && item.ordinal === ordinal);
  title.value = initialTitle.value = override?.title ?? block.title;
  detail.value = initialDetail.value = override?.detail ?? block.detail;
  error.value = "";
  conflict.value = false;
  latest.value = null;
}
async function close(): Promise<void> {
  if (saving.value) return;
  if (
    dirty.value &&
    !(await confirmAction({
      title: t("presentation.discard"),
      message: t("presentation.discardText"),
      confirmLabel: t("presentation.discardButton"),
      cancelLabel: t("presentation.keepEditing"),
      danger: true,
    }))
  )
    return;
  target.value = null;
}
async function loadLatest(): Promise<void> {
  if (!target.value) return;
  comparing.value = true;
  try {
    latest.value = await presentation.read(target.value.summary.id);
  } catch (e) {
    error.value = errorMessage(e, t("presentation.failed"));
  } finally {
    comparing.value = false;
  }
}
async function save(useLatest = false, restore = false): Promise<void> {
  const current = target.value;
  if (!current || saving.value || (!restore && invalid.value)) return;
  const snapshot = useLatest ? latest.value : null;
  if (useLatest && !snapshot) return;
  const state = cloneReportPresentationState(snapshot?.state ?? baseState.value);
  state.overrides = state.overrides.filter(
    (item) => item.section !== current.section || item.ordinal !== current.ordinal,
  );
  if (!restore && (title.value.trim() !== original.value?.title || detail.value.trim() !== original.value?.detail))
    state.overrides.push({
      section: current.section,
      ordinal: current.ordinal,
      title: title.value.trim(),
      detail: detail.value.trim(),
    });
  try {
    await presentation.save({
      summaryId: current.summary.id,
      expectedRevision: snapshot?.revision ?? revision.value,
      state,
    });
    target.value = null;
    showToast(t("presentation.saved"), "success");
  } catch (e) {
    conflict.value = e instanceof ApiError && e.code === "conflict";
    error.value = conflict.value ? t("presentation.conflict") : errorMessage(e, t("presentation.saveFailed"));
    latest.value = null;
  }
}
defineExpose({ open });
</script>
<template>
  <UiDialog
    :open="Boolean(target)"
    :title="t('presentation.editTitle')"
    :description="t('presentation.hint')"
    size="lg"
    :busy="saving"
    @close="close"
  >
    <div v-if="target" class="report-editor">
      <p>
        {{ target.summary.title }} · {{ target.summary.range.from }} – {{ target.summary.range.to }} ·
        {{ t("presentation.revision", { revision }) }}
      </p>
      <UiFlash v-if="props.displayedSummaryId !== target.summary.id" tone="attention">{{
        t("presentation.different")
      }}</UiFlash>
      <UiFlash v-if="error" tone="danger">{{ error }}</UiFlash>
      <section class="report-editor__original">
        <h3>{{ t("presentation.original") }}</h3>
        <strong>{{ original?.title }}</strong>
        <p>{{ original?.detail }}</p>
        <UiButton
          v-if="original?.sourceSessionIds.length"
          size="sm"
          @click="emit('openSources', original.sourceSessionIds)"
          >{{ t("reports.viewSourceSessions", { length: original.sourceSessionIds.length }) }}</UiButton
        >
      </section>
      <UiField :label="t('presentation.blockTitle')" group
        ><UiTextInput v-model="title" :maxlength="300" :label="t('presentation.blockTitle')"
      /></UiField>
      <UiField :label="t('presentation.detail')" :hint="t('presentation.budget')"
        ><UiTextarea v-model="detail" :rows="6" :maxlength="4000"
      /></UiField>
      <p>{{ manualLength }} / 8,000</p>
      <UiButton v-if="conflict" :loading="comparing" @click="loadLatest">{{ t("presentation.latest") }}</UiButton>
      <section v-if="latest" class="report-editor__original">
        <h3>{{ t("presentation.latestContent") }} · {{ t("presentation.revision", { revision: latest.revision }) }}</h3>
        <strong>{{ latestBlock?.title }}</strong>
        <p>{{ latestBlock?.detail }}</p>
      </section>
    </div>
    <template #footer>
      <UiButton :disabled="saving" @click="close">{{ t("common.cancel") }}</UiButton>
      <UiButton :disabled="saving || conflict" @click="save(false, true)">{{
        t("presentation.restoreBlock")
      }}</UiButton>
      <UiButton v-if="latest" variant="primary" :disabled="invalid" :loading="saving" @click="save(true)">{{
        t("presentation.applyLatest")
      }}</UiButton>
      <UiButton v-else variant="primary" :disabled="invalid || conflict" :loading="saving" @click="save()">{{
        t("common.saveChanges")
      }}</UiButton>
    </template>
  </UiDialog>
</template>
<style scoped>
.report-editor {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
  overflow-wrap: anywhere;
}
.report-editor__original {
  padding: var(--space-3);
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.report-editor__original p {
  white-space: pre-wrap;
  color: var(--fg-muted);
  line-height: 1.6;
}
</style>
