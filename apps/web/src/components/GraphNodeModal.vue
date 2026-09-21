<script setup lang="ts">
import BaseModal from "./BaseModal.vue";

defineProps<{ open: boolean }>();
defineEmits<{ close: [] }>();
</script>

<template>
  <BaseModal :open="open" ariaLabel="Graph 節點詳細資料" panel-class="graph-node-modal" @close="$emit('close')">
    <slot />
  </BaseModal>
</template>
