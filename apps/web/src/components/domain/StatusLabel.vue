<script setup lang="ts">
import { computed } from "vue";
import UiLabel from "../ui/UiLabel.vue";
import type { StatusVisual } from "../../utils/status";

/** Renders a StatusVisual from utils/status.ts. Never map status → colour inline in a view. */
const props = withDefaults(defineProps<{ status: StatusVisual; showIcon?: boolean; text?: string }>(), {
  showIcon: true,
});
const icon = computed(() => (props.showIcon ? props.status.icon : undefined));
</script>

<template>
  <UiLabel :tone="status.tone" :icon="icon">{{ text ?? status.label }}</UiLabel>
</template>
