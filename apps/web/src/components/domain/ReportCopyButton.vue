<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { Check, Copy, Download } from "lucide-vue-next";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import UiTextarea from "../ui/UiTextarea.vue";
import { useToast } from "../../composables/useToast";
import { useReportPresentationStore } from "../../stores/report-presentation";
import { useReportsStore } from "../../stores/reports";
import { downloadText } from "../../utils/download";
import { errorMessage } from "../../utils/format";
import { locale, t } from "../../i18n";

/** Prepares a gated snapshot, then copies during a separate user gesture with a manual fallback. */
const props = defineProps<{ summaryId?: string; revision?: number; disabled?: boolean }>();
const presentation = useReportPresentationStore();
const reports = useReportsStore();
const { report, reportLoading, reportPeriod, reportDate, reportRange, reportProjectId } = storeToRefs(reports);
const { copyWithToast } = useToast();
const open = ref(false);
const loading = ref(false);
const content = ref("");
const filename = ref("");
const error = ref("");
const failed = ref(false);
const copied = ref(false);
const copying = ref(false);
let generation = 0;
let controller: AbortController | undefined;
const title = computed(() => t(props.summaryId ? "reportCopy.presentation" : "reportCopy.basic"));
const unavailable = computed(() => props.disabled || (!props.summaryId && (!report.value || reportLoading.value)));

function close(): void {
  generation += 1;
  controller?.abort();
  open.value = false;
  content.value = "";
  error.value = "";
  failed.value = false;
  copied.value = false;
  loading.value = false;
}
async function prepare(): Promise<void> {
  close();
  open.value = true;
  loading.value = true;
  const token = generation;
  controller = new AbortController();
  try {
    const result = props.summaryId
      ? await presentation.exportMarkdown(props.summaryId, props.revision ?? 0, locale.value, controller.signal)
      : await reports.prepareMarkdown(controller.signal);
    if (token === generation) {
      content.value = result.content;
      filename.value = result.filename;
    }
  } catch (e) {
    if (token === generation) error.value = errorMessage(e, t("reportCopy.prepareFailed"));
  } finally {
    if (token === generation) loading.value = false;
  }
}
async function copy(): Promise<void> {
  if (copying.value || !content.value) return;
  copying.value = true;
  copied.value = false;
  const token = generation;
  // The clipboard write starts synchronously in this click, with no preceding fetch or await.
  const success = await copyWithToast(content.value, t("ui.copiedToClipboard"));
  if (token === generation) {
    copied.value = success;
    failed.value = !success;
  }
  copying.value = false;
}
watch(
  [
    () => props.summaryId,
    () => props.revision,
    reportPeriod,
    reportDate,
    () => reportRange.value.from,
    () => reportRange.value.to,
    reportProjectId,
    locale,
  ],
  close,
);
onBeforeUnmount(close);
</script>
<template>
  <UiButton size="sm" :icon="Copy" :disabled="unavailable" @click="prepare">{{ title }}</UiButton>
  <UiDialog :open="open" :title="title" :description="t('reportCopy.description')" size="lg" @close="close">
    <UiSkeleton v-if="loading" variant="text" :count="3" :label="t('reportCopy.loading')" />
    <UiFlash v-else-if="error" tone="danger"
      >{{ error
      }}<template #actions
        ><UiButton size="sm" @click="prepare">{{ t("common.retry") }}</UiButton></template
      ></UiFlash
    >
    <template v-else-if="content">
      <UiFlash v-if="failed" tone="attention">{{ t("reportCopy.fallback") }}</UiFlash>
      <UiTextarea v-model="content" :rows="16" mono readonly :aria-label="t('reportCopy.preview')" />
    </template>
    <template #footer>
      <UiButton @click="close">{{ t("common.cancel") }}</UiButton>
      <UiButton v-if="content" :icon="Download" @click="downloadText(content, filename)">{{
        t("reports.downloadMarkdown")
      }}</UiButton>
      <UiButton v-if="content" variant="primary" :icon="copied ? Check : Copy" :disabled="copying" @click="copy">{{
        t(copied ? "reportCopy.copied" : "ui.copy")
      }}</UiButton>
    </template>
  </UiDialog>
</template>
