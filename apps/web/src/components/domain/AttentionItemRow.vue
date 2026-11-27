<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { ArrowRight, Check, MoreHorizontal, X } from "lucide-vue-next";
import type { AttentionItem, UpdateAttentionPreference } from "@work-intelligence/core";
import UiActionMenu from "../ui/UiActionMenu.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiButton from "../ui/UiButton.vue";
import UiLabel from "../ui/UiLabel.vue";
import { useProjectsStore } from "../../stores/projects";
import { attentionKindKeys, attentionReasonKeys, attentionRoute } from "../../utils/attention";
import { formatDate, formatRelative } from "../../utils/format";
import { t } from "../../i18n";

/** One attention pointer: what it is, why it is listed, and the actions that settle it or lead to its page. */
const props = defineProps<{
  item: AttentionItem;
  view: "visible" | "suppressed";
  waiting: boolean;
  saving: boolean;
  reviewing: boolean;
  nested?: boolean;
}>();

const emit = defineEmits<{
  review: [reviewStatus: "confirmed" | "rejected"];
  preference: [action: UpdateAttentionPreference["action"]];
}>();

const { projects } = storeToRefs(useProjectsStore());

const preferenceActions = computed(() => [
  { value: "snooze" as const, label: t("attention.snooze") },
  { value: "hide" as const, label: t("attention.hide") },
]);
const title = computed(() => props.item.title || t(attentionKindKeys[props.item.kind]));
const meta = computed(() =>
  t("attention.rowMeta", {
    source: t(attentionKindKeys[props.item.kind]),
    project:
      props.item.projectName ||
      projects.value.find((project) => project.id === props.item.projectId)?.name ||
      t("common.allTrackedProjects"),
    updated: formatRelative(props.item.updatedAt),
    count: props.item.count ?? 1,
  }),
);
const reasonLabel = computed(() => {
  if (props.waiting) return t("attention.waitingForAgent");
  return t(attentionReasonKeys[props.item.reason], { count: props.item.count ?? 1 });
});
const reasonTone = computed(() => {
  if (props.waiting) return "accent";
  if (props.item.reason === "failed") return "danger";
  return props.item.reason === "processing" ? "neutral" : "attention";
});
const canReview = computed(
  () =>
    props.view === "visible" &&
    props.item.kind === "decision" &&
    props.item.reason === "pending" &&
    Boolean(props.item.projectId),
);
const to = computed(() => attentionRoute(props.item));
</script>

<template>
  <UiBoxRow tag="li" :class="['attention-row', { 'attention-row--nested': nested }]" :title="title" :meta="meta">
    <template #trailing>
      <UiLabel :tone="reasonTone">{{ reasonLabel }}</UiLabel>
      <span v-if="item.preference?.snoozedUntil" class="attention-row__note">{{
        t("attention.until", { date: formatDate(item.preference.snoozedUntil) })
      }}</span>
      <template v-if="canReview">
        <UiButton
          size="sm"
          :icon="Check"
          :loading="reviewing"
          :disabled="reviewing"
          @click="emit('review', 'confirmed')"
          >{{ t("common.confirm") }}</UiButton
        >
        <UiButton size="sm" :icon="X" :disabled="reviewing" @click="emit('review', 'rejected')">{{
          t("knowledge.reject")
        }}</UiButton>
      </template>
      <UiButton
        v-if="view === 'suppressed' && item.preference"
        size="sm"
        :disabled="saving"
        @click="emit('preference', 'restore')"
        >{{ t("attention.restore") }}</UiButton
      >
      <UiActionMenu
        v-else-if="item.preference"
        :label="t('attention.preferenceActions')"
        :items="preferenceActions"
        :icon="MoreHorizontal"
        size="sm"
        @select="emit('preference', $event)"
      />
      <UiButton size="sm" :to="to" :trailing-icon="ArrowRight">{{ t("attention.openSource") }}</UiButton>
    </template>
  </UiBoxRow>
</template>

<style scoped>
.attention-row :deep(.ui-box-row__trailing) {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.attention-row :deep(.ui-box-row__meta) {
  white-space: normal;
  overflow-wrap: anywhere;
}

.attention-row--nested {
  padding-left: var(--space-6);
  background: var(--bg-subtle);
}

.attention-row__note {
  color: var(--fg-muted);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}

@media (max-width: 639px) {
  .attention-row {
    flex-wrap: wrap;
  }

  .attention-row :deep(.ui-box-row__main) {
    flex-basis: 100%;
  }

  .attention-row :deep(.ui-box-row__trailing) {
    margin-left: auto;
  }
}
</style>
