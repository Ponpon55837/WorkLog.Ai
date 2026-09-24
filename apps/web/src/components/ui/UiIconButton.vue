<script setup lang="ts">
import type { IconComponent } from "./types";
import UiButton from "./UiButton.vue";

withDefaults(
  defineProps<{
    icon: IconComponent;
    /** Required accessible name; also shown as the native tooltip. */
    label: string;
    variant?: "default" | "invisible" | "danger";
    size?: "md" | "sm";
    loading?: boolean;
    disabled?: boolean;
  }>(),
  { variant: "invisible", size: "md" },
);
</script>

<template>
  <UiButton
    :icon="icon"
    :label="label"
    :aria-label="label"
    :variant="variant"
    :size="size"
    :loading="loading"
    :disabled="disabled"
    icon-only
  />
</template>
