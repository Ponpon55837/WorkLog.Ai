<script setup lang="ts">
import { storeToRefs } from "pinia";
import { FolderTree } from "lucide-vue-next";
import UiBox from "../ui/UiBox.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiLabel from "../ui/UiLabel.vue";
import { useUsageStore } from "../../stores/usage";
import { formatTokens } from "../../utils/format";
import { t } from "../../i18n";

/** Conversations opened above several projects: what stays unallocated and what each project received. */
const usageStore = useUsageStore();
const { sharedRows } = storeToRefs(usageStore);
</script>

<template>
  <UiBox v-if="sharedRows.length > 0" data-testid="usage-shared">
    <template #header><UiBoxTitle :icon="FolderTree" :title="t('usage.sharedTitle')" /></template>
    <p class="usage-shared__hint">{{ t("usage.sharedDescription") }}</p>
    <template v-for="group in sharedRows" :key="group.key">
      <UiBoxRow data-testid="usage-unallocated">
        <template #title>{{ t("usage.sharedUnallocated", { projects: group.names }) }}</template>
        <template #labels
          ><UiLabel :tone="group.included ? 'success' : 'attention'">{{
            group.included ? t("usage.sharedCounted") : t("usage.sharedNotCounted")
          }}</UiLabel></template
        >
        <template #meta>{{
          t("usage.sharedMeta", {
            conversations: group.conversations,
            tokens: formatTokens(group.primary),
          })
        }}</template>
      </UiBoxRow>
      <UiBoxRow v-for="entry in group.projects" :key="entry.projectId" data-testid="usage-allocated">
        <template #title>{{ entry.name }}</template>
        <template #labels
          ><UiLabel v-if="!entry.included" tone="neutral">{{ t("usage.sharedNotSelected") }}</UiLabel></template
        >
        <template #meta
          >{{
            t("usage.sharedMeta", {
              conversations: entry.conversations,
              tokens: formatTokens(entry.primary),
            })
          }}
          · {{ t("usage.basisCounts", entry.byBasis) }}</template
        >
      </UiBoxRow>
    </template>
  </UiBox>
</template>

<style scoped>
.usage-shared__hint {
  margin: 0;
  padding: var(--space-2) var(--space-4);
  color: var(--fg-muted);
  font-size: var(--text-sm);
}
</style>
