<script setup lang="ts">
import { ref } from "vue";
import { Check, Copy } from "lucide-vue-next";
import { useToast } from "../../composables/useToast";
import UiButton from "./UiButton.vue";

const props = withDefaults(
  defineProps<{
    text: string;
    label?: string;
    successMessage?: string;
    variant?: "default" | "primary" | "invisible";
    size?: "md" | "sm";
    iconOnly?: boolean;
  }>(),
  { label: "複製", successMessage: "已複製到剪貼簿。", variant: "default", size: "md" },
);

const copied = ref(false);

async function copy(): Promise<void> {
  await useToast().copyWithToast(props.text, props.successMessage);
  copied.value = true;
  window.setTimeout(() => (copied.value = false), 1_500);
}
</script>

<template>
  <UiButton
    :variant="variant"
    :size="size"
    :icon="copied ? Check : Copy"
    :icon-only="iconOnly"
    :label="label"
    :aria-label="iconOnly ? label : undefined"
    @click="copy"
  >
    {{ label }}
  </UiButton>
</template>
