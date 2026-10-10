<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { History, MoreHorizontal, Pencil, Pin } from "lucide-vue-next";
import {
  cloneReportPresentationState,
  emptyReportPresentation,
  projectReportSummary,
  type ReportSectionKey,
  type ReportSummary,
} from "@work-intelligence/core";
import { confirmAction } from "../../composables/useConfirm";
import { useReportPresentationStore } from "../../stores/report-presentation";
import { useReportsStore } from "../../stores/reports";
import { errorMessage, formatDate } from "../../utils/format";
import type { MessageKey } from "../../i18n";
import UiActionMenu from "../ui/UiActionMenu.vue";
import UiButton from "../ui/UiButton.vue";
import UiDisclosure from "../ui/UiDisclosure.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import UiLabel from "../ui/UiLabel.vue";
import ReportCopyButton from "./ReportCopyButton.vue";
import ReportBlockEditor from "./ReportBlockEditor.vue";
import SynthesisBlock from "./SynthesisBlock.vue";
import { t } from "../../i18n";

const props = defineProps<{ summary: ReportSummary; themeHint?: string }>();
const emit = defineEmits<{ openSources: [sessionIds: string[]] }>();
const presentation = useReportPresentationStore();
const { data, state, error, saving, loading } = storeToRefs(presentation);
const reports = useReportsStore();
const editor = ref<InstanceType<typeof ReportBlockEditor> | null>(null);
const actionError = ref("");
const controls = ref<HTMLElement | null>(null);
const keys: Record<ReportSectionKey, MessageKey> = {
  themes: "reports.theme",
  highlights: "reports.keyOutcomes",
  verification: "common.verification",
  comparison: "reports.compare",
  risks: "reports.risksAndLimits",
  decisions: "common.decisions",
  nextSteps: "common.statusOpenItems",
};
const sections = computed(() => projectReportSummary(props.summary, state.value));
const modified = computed(
  () => state.value.pinned.length + state.value.hidden.length + state.value.overrides.length > 0,
);

function options(key: ReportSectionKey) {
  return [
    { value: "pin", label: t(state.value.pinned.includes(key) ? "presentation.unpin" : "presentation.pin") },
    { value: "hide", label: t("presentation.hide") },
  ];
}
async function saveState(next: typeof state.value): Promise<void> {
  const current = data.value;
  if (!current) return;
  actionError.value = "";
  try {
    await presentation.save({ summaryId: props.summary.id, expectedRevision: current.revision, state: next });
  } catch (e) {
    actionError.value = errorMessage(e, t("presentation.saveFailed"));
  }
}
async function change(key: ReportSectionKey, action: string): Promise<void> {
  if (!data.value || saving.value) return;
  const next = cloneReportPresentationState(data.value.state);
  if (action === "pin")
    next.pinned = next.pinned.includes(key) ? next.pinned.filter((item) => item !== key) : [...next.pinned, key];
  if (action === "hide") next.hidden = [...next.hidden, key];
  if (action === "restore") next.hidden = next.hidden.filter((item) => item !== key);
  await saveState(next);
  if (action === "hide") {
    await nextTick();
    controls.value?.querySelector<HTMLButtonElement>("button")?.focus();
  }
}
async function reload(): Promise<void> {
  actionError.value = "";
  await presentation.reload();
}
async function reset(): Promise<void> {
  if (
    saving.value ||
    !data.value ||
    !(await confirmAction({
      title: t("presentation.reset"),
      message: t("presentation.resetConfirm"),
      confirmLabel: t("presentation.reset"),
      cancelLabel: t("common.cancel"),
      danger: true,
    }))
  )
    return;
  await saveState(emptyReportPresentation());
}
function edit(section: ReportSectionKey, ordinal: number): void {
  if (!data.value) return;
  reports.selectReportSynthesisVersion(props.summary);
  editor.value?.open(props.summary, section, ordinal, data.value);
}
watch(
  () => props.summary.id,
  (id) => {
    presentation.setSummary(id);
    actionError.value = "";
  },
  { immediate: true },
);
onBeforeUnmount(() => presentation.setSummary(""));
</script>
<template>
  <div
    class="synthesis-presentation"
    role="region"
    :aria-label="t('presentation.title')"
    data-testid="synthesis-presentation"
  >
    <UiFlash v-if="error || actionError" tone="danger"
      >{{ error || actionError }} <UiButton size="sm" @click="reload">{{ t("common.retry") }}</UiButton></UiFlash
    >
    <UiSkeleton v-if="loading && !data" variant="text" :count="3" :label="t('presentation.loading')" />
    <p v-else-if="!data && !error">{{ t("presentation.unknown") }}</p>
    <p v-if="data" class="synthesis-presentation__executive">{{ summary.executiveSummary }}</p>
    <div v-if="data" ref="controls" class="synthesis-presentation__controls">
      <ReportCopyButton :summary-id="summary.id" :revision="data.revision" :disabled="saving" />
      <UiLabel>{{ t("presentation.revision", { revision: data.revision }) }}</UiLabel
      ><UiButton size="sm" :disabled="saving" @click="reload">{{ t("presentation.refresh") }}</UiButton>
      <UiButton v-if="modified" size="sm" :disabled="saving" @click="reset">{{ t("presentation.reset") }}</UiButton>
    </div>
    <UiDisclosure v-if="state.hidden.length" :title="t('presentation.hidden', { count: state.hidden.length })" open>
      <div class="synthesis-presentation__controls">
        <UiButton v-for="key in state.hidden" :key="key" size="sm" :disabled="saving" @click="change(key, 'restore')">{{
          t("presentation.restore", { title: t(keys[key]) })
        }}</UiButton>
      </div>
    </UiDisclosure>
    <SynthesisBlock
      v-for="section in data ? sections : []"
      :key="section.key"
      data-testid="synthesis-block"
      :data-section="section.key"
      :title="t(keys[section.key])"
      :hint="section.key === 'themes' ? themeHint : undefined"
      :blocks="section.blocks"
      @open-sources="emit('openSources', $event)"
    >
      <template #actions
        ><Pin v-if="section.pinned" :size="14" aria-hidden="true" /><UiActionMenu
          v-if="data && !saving"
          :label="t('presentation.actions')"
          :header="t(keys[section.key])"
          :icon="MoreHorizontal"
          size="sm"
          :items="options(section.key)"
          @select="change(section.key, $event)"
      /></template>
      <template #block-actions="{ block, ordinal }"
        ><UiLabel v-if="block.edited" tone="attention">{{ t("presentation.edited") }}</UiLabel
        ><UiIconButton
          v-if="data"
          :icon="Pencil"
          :label="t('presentation.edit', { title: block.title })"
          size="sm"
          :disabled="saving"
          @click="edit(section.key, ordinal)"
      /></template>
    </SynthesisBlock>
    <UiDisclosure
      v-if="data?.history.length"
      :title="t('presentation.history')"
      :icon="History"
      :count="data.history.length"
      ><ul class="synthesis-presentation__history">
        <li v-for="item in data.history" :key="item.revision">
          {{ t("presentation.revision", { revision: item.revision }) }} · {{ formatDate(item.createdAt) }} · Web
        </li>
      </ul></UiDisclosure
    >
    <ReportBlockEditor ref="editor" :displayed-summary-id="summary.id" @open-sources="emit('openSources', $event)" />
  </div>
</template>
<style scoped>
.synthesis-presentation {
  display: grid;
  gap: var(--space-4);
  min-width: 0;
}
.synthesis-presentation__executive {
  font-size: var(--text-lg);
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.synthesis-presentation__controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) 0;
}
.synthesis-presentation__history {
  max-height: 240px;
  overflow: auto;
  padding: var(--space-3);
  list-style: none;
  font-size: var(--text-sm);
  color: var(--fg-muted);
}
</style>
