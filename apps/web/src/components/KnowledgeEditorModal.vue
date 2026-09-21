<script setup lang="ts">
import BaseModal from "./BaseModal.vue";

defineProps<{ open: boolean }>();
defineEmits<{ close: [] }>();
</script>

<template>
  <BaseModal :open="open" ariaLabel="編輯 Knowledge" panel-class="knowledge-editor-modal" @close="$emit('close')">
    <slot />
  </BaseModal>
</template>
