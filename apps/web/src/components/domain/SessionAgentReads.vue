<script setup lang="ts">
import { storeToRefs } from "pinia";
import { Eye } from "lucide-vue-next";
import UiDisclosure from "../ui/UiDisclosure.vue";
import { useAgentReadsStore } from "../../stores/agent-reads";
import { formatDate } from "../../utils/format";
import { t } from "../../i18n";

/** When Agents were given the open Session through an MCP read (collapsed; hidden when it never happened). */
const { sessionReads } = storeToRefs(useAgentReadsStore());
</script>

<template>
  <UiDisclosure
    v-if="sessionReads && sessionReads.total > 0"
    :title="t('session.agentReads')"
    :icon="Eye"
    :count="sessionReads.total"
    :hint="t('session.agentReadsHint')"
    data-testid="session-agent-reads"
  >
    <ul class="session-agent-reads">
      <li v-for="(read, index) in sessionReads.items" :key="`${read.at}-${index}`">
        <time :datetime="read.at">{{ formatDate(read.at) }}</time>
        <code>{{ read.tool }}</code>
        <span>{{ read.agentClient ?? t("systemStatus.agentReadsUnknownAgent") }}</span>
      </li>
    </ul>
    <p v-if="sessionReads.total > sessionReads.items.length" class="session-agent-reads__more">
      {{ t("session.agentReadsRecentOnly", { count: sessionReads.items.length }) }}
    </p>
  </UiDisclosure>
</template>

<style scoped>
.session-agent-reads {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: var(--space-3) var(--space-4);
  list-style: none;
  font-size: var(--text-sm);
}

.session-agent-reads li {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  color: var(--fg-muted);
}

.session-agent-reads__more {
  margin: 0;
  padding: 0 var(--space-4) var(--space-3);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}
</style>
