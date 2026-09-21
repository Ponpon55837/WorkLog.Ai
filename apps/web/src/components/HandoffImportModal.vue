<script setup lang="ts">
import BaseModal from "./BaseModal.vue";

defineProps<{ open: boolean }>();
defineEmits<{ close: [] }>();
</script>

<template>
  <BaseModal :open="open" ariaLabel="Handoff import preview" panel-class="import-modal" backdrop-class="import-backdrop" @close="$emit('close')">
    <slot />
  </BaseModal>
</template>
