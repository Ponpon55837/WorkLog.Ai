<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import { storeToRefs } from "pinia";
import { Link2 } from "lucide-vue-next";
import UiButton from "../ui/UiButton.vue";
import UiDisclosure from "../ui/UiDisclosure.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiSkeleton from "../ui/UiSkeleton.vue";
import { useRelatedWorkStore } from "../../stores/related-work";
import { useSessionsStore } from "../../stores/sessions";
import { formatDate } from "../../utils/format";
import { t } from "../../i18n";

const props = defineProps<{ sessionId: string }>();
const sessions = useSessionsStore();
const related = useRelatedWorkStore();
const { data, error } = storeToRefs(related);
const reasonLabel = computed(() =>
  data.value?.reason
    ? {
        source_unavailable: t("related.sourceUnavailable"),
        files_unconfirmed: t("related.filesUnconfirmed"),
        no_files: t("related.noFiles"),
        too_many_files: t("related.tooManyFiles"),
      }[data.value.reason]
    : "",
);
watch(
  () => props.sessionId,
  (id) => related.setSource(id),
  { immediate: true },
);
onBeforeUnmount(() => related.setSource(""));
</script>
<template>
  <UiDisclosure :title="t('related.title')" :icon="Link2" open data-testid="related-work">
    <div class="related-work__content" data-testid="related-work-content">
      <p>{{ t("related.hint") }}</p>
      <UiFlash v-if="error" tone="danger"
        >{{ t("related.failed") }}
        <UiButton size="sm" @click="related.reload">{{ t("common.retry") }}</UiButton></UiFlash
      >
      <UiSkeleton v-else-if="!data" variant="text" :count="2" />
      <template v-else>
        <UiFlash v-if="data.coverage.partial" tone="attention">{{ t("related.partial") }}</UiFlash>
        <p v-if="data.reason">{{ reasonLabel }}</p>
        <p v-else-if="!data.items.length">{{ t("related.empty") }}</p>
        <ul v-else class="related-work__list">
          <li v-for="item in data.items" :key="item.id">
            <UiButton class="related-work__title" variant="invisible" @click="sessions.openSessionDetail(item.id)">{{
              item.title
            }}</UiButton>
            <time :datetime="item.completedAt">{{ formatDate(item.completedAt) }}</time>
            <p>{{ t("related.shared", { count: item.sharedCount }) }}</p>
            <p class="mono">
              {{ item.sharedPaths.join(" · ") }}<span v-if="item.pathsOmitted"> · +{{ item.pathsOmitted }}</span>
            </p>
          </li>
        </ul>
      </template>
    </div>
  </UiDisclosure>
</template>
<style scoped>
.related-work__content {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-3);
  overflow-wrap: anywhere;
}

.related-work__title {
  height: auto;
  min-height: var(--control-height);
  width: 100%;
  justify-content: flex-start;
  padding: 0;
  white-space: normal;
  text-align: left;
  line-height: 1.5;
  color: var(--accent);
}
.related-work__title :deep(span) {
  overflow-wrap: anywhere;
  min-width: 0;
}
.related-work__list {
  display: grid;
  gap: var(--space-4);
  margin: 0;
  padding: 0;
  list-style: none;
}
.related-work__list li {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
  overflow-wrap: anywhere;
}
.related-work__list time,
.related-work__list p {
  display: block;
  color: var(--fg-muted);
  font-size: var(--text-sm);
}
</style>
