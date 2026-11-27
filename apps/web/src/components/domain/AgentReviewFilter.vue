<script setup lang="ts">
import { computed } from "vue";
import type { AgentReviewListFilter } from "../../stores/agent-review";
import UiSegmentedControl from "../ui/UiSegmentedControl.vue";
import { t } from "../../i18n";

const props = defineProps<{ pendingLabel?: string }>();
const model = defineModel<AgentReviewListFilter>({ required: true });

const options = computed(() => [
  { value: "pending" as const, label: props.pendingLabel ?? t("knowledge.reviewFilterPending") },
  { value: "agent" as const, label: t("knowledge.reviewFilterAgent") },
]);
</script>

<template>
  <UiSegmentedControl v-model="model" size="sm" :options="options" :label="t('knowledge.reviewFilterLabel')" />
</template>
