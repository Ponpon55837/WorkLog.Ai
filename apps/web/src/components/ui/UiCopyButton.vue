<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Check, Copy } from "lucide-vue-next";
import { useToast } from "../../composables/useToast";
import UiButton from "./UiButton.vue";
import { t } from "../../i18n";

/** Shows copied feedback only after a successful write and clears timers when content or ownership changes. */
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
const copying = ref(false);
let mounted = true;
let timer: ReturnType<typeof setTimeout> | undefined;

// Defaults are resolved here, not in withDefaults, so they follow the current locale.
const buttonLabel = computed(() => props.label ?? t("ui.copy"));

async function copy(): Promise<void> {
  if (copying.value) return;
  copying.value = true;
  if (timer) clearTimeout(timer);
  copied.value = false;
  const value = props.text;
  try {
    const success = await useToast().copyWithToast(value, props.successMessage ?? t("ui.copiedToClipboard"));
    if (mounted && value === props.text) {
      copied.value = success;
      if (success) timer = setTimeout(() => (copied.value = false), 1_500);
    }
  } finally {
    copying.value = false;
  }
}
watch(
  () => props.text,
  () => {
    copied.value = false;
    if (timer) clearTimeout(timer);
  },
);
onBeforeUnmount(() => {
  mounted = false;
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <UiButton
    :variant="variant"
    :size="size"
    :icon="copied ? Check : Copy"
    :icon-only="iconOnly"
    :label="buttonLabel"
    :aria-label="iconOnly ? buttonLabel : undefined"
    :disabled="copying"
    @click="copy"
  >
    {{ buttonLabel }}
  </UiButton>
</template>
