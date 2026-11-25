<script setup lang="ts">
import { computed } from "vue";
import { knowledgePageLimits } from "@work-intelligence/core";
import { formatCount } from "../../utils/format";
import UiFlash from "../ui/UiFlash.vue";
import { t } from "../../i18n";

/** Shows a Knowledge page's size against its limits and, when near them, which sections to move to a custom page. */
const props = defineProps<{ sections: ReadonlyArray<{ heading: string; content: string }> }>();

const limits = computed(() => knowledgePageLimits(props.sections));
const suggestion = computed(() => limits.value.splitSuggestion);
const isOver = computed(() => {
  const { size } = limits.value;
  return size.sectionCount > size.maxSections || size.contentChars > size.maxContentChars;
});
const usage = computed(() => {
  const { size } = limits.value;
  return t("knowledge.pageLimitUsage", {
    chars: formatCount(size.contentChars),
    maxChars: formatCount(size.maxContentChars),
    count: formatCount(size.sectionCount),
    max: formatCount(size.maxSections),
  });
});
const advice = computed(() => {
  const headings = (suggestion.value?.headings ?? []).filter((heading) => heading.trim() !== "");
  if (headings.length === 0) return t("knowledge.pageLimitMoveLargest");
  const quoted = headings.map((heading) => t("knowledge.pageLimitHeading", { heading }));
  return t("knowledge.pageLimitMoveSections", { headings: quoted.join(t("common.listSeparator")) });
});
</script>

<template>
  <UiFlash
    v-if="suggestion"
    :tone="isOver ? 'danger' : 'attention'"
    :title="isOver ? t('knowledge.pageLimitOverTitle') : t('knowledge.pageLimitNearTitle')"
    data-testid="knowledge-page-limit"
  >
    <span class="page-limit__usage">{{ usage }}</span>
    <span>{{ advice }} {{ t("knowledge.pageLimitCustomPageHint") }}</span>
    <span v-if="isOver">{{ t("knowledge.pageLimitOverSave") }}</span>
  </UiFlash>
</template>

<style scoped>
.page-limit__usage {
  font-variant-numeric: tabular-nums;
}
</style>
