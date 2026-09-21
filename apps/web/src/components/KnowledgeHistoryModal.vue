<script setup lang="ts">
import BaseModal from "./BaseModal.vue";

defineProps<{ open: boolean }>();
defineEmits<{ close: [] }>();
</script>

<template>
  <BaseModal :open="open" ariaLabel="Knowledge 變更紀錄" panel-class="knowledge-history-modal" @close="$emit('close')">
    <slot />
  </BaseModal>
</template>
