<script setup lang="ts">
import { onBeforeUnmount, watch } from "vue";

const props = withDefaults(defineProps<{
  open: boolean;
  ariaLabel: string;
  panelClass?: string;
  backdropClass?: string;
}>(), {
  panelClass: "",
  backdropClass: ""
});

const emit = defineEmits<{ close: [] }>();

let locked = false;
function setScrollLock(lock: boolean): void {
  if (lock === locked) {
    return;
  }
  locked = lock;
  const count = Number(document.body.dataset.modalCount ?? 0) + (lock ? 1 : -1);
  document.body.dataset.modalCount = String(Math.max(0, count));
  document.body.classList.toggle("modal-open", count > 0);
}

watch(() => props.open, setScrollLock, { immediate: true });
onBeforeUnmount(() => setScrollLock(false));
</script>

<template>
  <div
    v-if="open"
    :class="['modal-backdrop', backdropClass]"
    tabindex="-1"
    @click.self="emit('close')"
    @keydown.esc="emit('close')"
  >
    <section :class="['detail-modal', panelClass]" role="dialog" aria-modal="true" :aria-label="ariaLabel">
      <slot />
    </section>
  </div>
</template>
