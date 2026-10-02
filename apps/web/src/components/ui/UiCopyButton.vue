<script setup lang="ts">
import { computed, ref } from "vue";
import { Check, Copy } from "lucide-vue-next";
import { useToast } from "../../composables/useToast";
import UiButton from "./UiButton.vue";
import { t } from "../../i18n";

const props = withDefaults(
  defineProps<{
    text: string;
    label?: string;
    successMessage?: string;
    variant?: "default" | "primary" | "invisible";
    size?: "md" | "sm";
    iconOnly?: boolean;
  }>(),
  { variant: "default", size: "md" },
);

const copied = ref(false);

// Defaults are resolved here, not in withDefaults, so they follow the current locale.
const buttonLabel = computed(() => props.label ?? t("ui.copy"));

async function copy(): Promise<void> {
  await useToast().copyWithToast(props.text, props.successMessage ?? t("ui.copiedToClipboard"));
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
    :label="buttonLabel"
    :aria-label="iconOnly ? buttonLabel : undefined"
    @click="copy"
  >
    {{ buttonLabel }}
  </UiButton>
</template>
