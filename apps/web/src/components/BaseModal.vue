<script setup lang="ts">
withDefaults(defineProps<{
  open: boolean;
  ariaLabel: string;
  panelClass?: string;
  backdropClass?: string;
}>(), {
  panelClass: "",
  backdropClass: ""
});

const emit = defineEmits<{ close: [] }>();
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
