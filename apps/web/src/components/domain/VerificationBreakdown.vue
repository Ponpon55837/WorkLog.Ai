<script setup lang="ts">
import { computed } from "vue";
import { verificationStatus } from "../../utils/status";
import UiMeter from "../ui/UiMeter.vue";

/**
 * Four-state verification distribution. Deliberately no single pass-rate percentage: missing
 * verification (未回報) must never be folded into pass or fail.
 */
const props = defineProps<{ counts: { passed: number; failed: number; notRun: number; notSupplied: number } }>();

const segments = computed(() => [
  { value: props.counts.passed, tone: verificationStatus.passed.tone, label: verificationStatus.passed.label },
  { value: props.counts.failed, tone: verificationStatus.failed.tone, label: verificationStatus.failed.label },
  { value: props.counts.notRun, tone: verificationStatus.not_run.tone, label: verificationStatus.not_run.label },
  {
    value: props.counts.notSupplied,
    tone: verificationStatus.not_supplied.tone,
    label: verificationStatus.not_supplied.label,
  },
]);
const summary = computed(() =>
  segments.value
    .slice(1)
    .filter((segment) => segment.value > 0)
    .map((segment) => `${segment.value} ${segment.label}`)
    .join(" · "),
);
</script>

<template>
  <UiMeter :segments="segments" :label="segments.map((segment) => `${segment.label} ${segment.value}`).join('，')" />
  <div class="verification-breakdown__foot">{{ summary || "沒有失敗或缺漏" }}</div>
</template>

<style scoped>
.verification-breakdown__foot {
  margin-top: var(--space-2);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}
</style>
