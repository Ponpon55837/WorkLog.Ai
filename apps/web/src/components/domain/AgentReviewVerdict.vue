<script setup lang="ts">
import { Undo2 } from "lucide-vue-next";
import type { AgentVerdictKind } from "../../utils/status";
import StatusLabel from "./StatusLabel.vue";
import UiButton from "../ui/UiButton.vue";
import { formatDate, formatRelative } from "../../utils/format";
import { agentVerdictVisual } from "../../utils/status";
import { t } from "../../i18n";

/** What an Agent decided on an item, why, and when. The reason is untrusted Agent text and renders as plain text. */
defineProps<{ verdict: AgentVerdictKind; reason?: string; reviewedAt?: string }>();
const emit = defineEmits<{ overturn: [] }>();
</script>

<template>
  <div class="agent-review-verdict" data-testid="agent-review-verdict">
    <div class="agent-review-verdict__head">
      <StatusLabel :status="agentVerdictVisual[verdict]" />
      <span class="agent-review-verdict__by">{{ t("knowledge.processedByAgent") }}</span>
      <time v-if="reviewedAt" class="agent-review-verdict__time" :title="formatDate(reviewedAt)">{{
        formatRelative(reviewedAt)
      }}</time>
      <UiButton class="agent-review-verdict__overturn" size="sm" :icon="Undo2" @click="emit('overturn')">{{
        t("knowledge.overturn")
      }}</UiButton>
    </div>
    <p v-if="reason" class="agent-review-verdict__reason">{{ reason }}</p>
  </div>
</template>

<style scoped>
.agent-review-verdict {
  display: grid;
  gap: var(--space-1);
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius);
  background: var(--bg-subtle);
}

.agent-review-verdict__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.agent-review-verdict__overturn {
  margin-inline-start: auto;
}

.agent-review-verdict__reason {
  margin: 0;
  color: var(--fg);
  font-size: var(--text-sm);
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
