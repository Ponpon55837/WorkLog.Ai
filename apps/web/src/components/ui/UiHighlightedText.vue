<script setup lang="ts">
import { computed } from "vue";
import { highlightSegments } from "../../utils/highlight";

const props = defineProps<{ text: string; query?: string }>();

const segments = computed(() => highlightSegments(props.text, props.query ?? ""));
</script>

<template>
  <template v-for="(segment, index) in segments" :key="index"
    ><mark v-if="segment.match" class="ui-highlighted-text">{{ segment.text }}</mark
    ><template v-else>{{ segment.text }}</template></template
  >
</template>

<style scoped>
.ui-highlighted-text {
  padding: 0 1px;
  border-radius: var(--radius-xs);
  background: var(--attention-soft);
  color: inherit;
  font-weight: 600;
}
</style>
