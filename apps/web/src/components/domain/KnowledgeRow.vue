<script setup lang="ts">
import { computed, ref } from "vue";
import { Archive, ArchiveRestore, CheckCheck, ExternalLink, FileSearch, History, Pencil } from "lucide-vue-next";
import type { KnowledgeRecord } from "@work-intelligence/core";
import { formatDate, formatRelative } from "../../utils/format";
import { knowledgeKindVisual, knowledgeStatusVisual, knowledgeTrustVisual } from "../../utils/status";
import UiActionMenu from "../ui/UiActionMenu.vue";
import UiBoxRow from "../ui/UiBoxRow.vue";
import UiLabel from "../ui/UiLabel.vue";
import StatusLabel from "./StatusLabel.vue";
import { t } from "../../i18n";

export type KnowledgeAction = "edit" | "history" | "toggle-status" | "source" | "confirm" | "stale-source";

const props = defineProps<{ item: KnowledgeRecord }>();
const emit = defineEmits<{ action: [action: KnowledgeAction, item: KnowledgeRecord] }>();

const expanded = ref(false);
const kind = computed(() => knowledgeKindVisual[props.item.kind]);
const actions = computed(() => [
  { value: "edit" as const, label: t("knowledge.edit"), icon: Pencil },
  { value: "confirm" as const, label: t("knowledge.stillValid"), icon: CheckCheck },
  ...(props.item.possiblyStale
    ? [{ value: "stale-source" as const, label: t("knowledge.viewTheSessionThatChanged"), icon: FileSearch }]
    : []),
  { value: "history" as const, label: t("knowledge.changeHistory"), icon: History },
  ...(props.item.sessionId
    ? [{ value: "source" as const, label: t("knowledge.viewSourceSession"), icon: ExternalLink }]
    : []),
  props.item.status === "active"
    ? { value: "toggle-status" as const, label: t("common.archive"), icon: Archive }
    : { value: "toggle-status" as const, label: t("knowledge.restore"), icon: ArchiveRestore },
]);
</script>

<template>
  <UiBoxRow tag="article" data-testid="knowledge-row">
    <template #leading>
      <component :is="kind.icon" :size="16" :stroke-width="1.75" :class="`tone-${kind.tone}`" aria-hidden="true" />
    </template>
    <template #title>{{ item.title }}</template>
    <template #labels>
      <StatusLabel :status="kind" :show-icon="false" />
      <StatusLabel v-if="item.status !== 'active'" :status="knowledgeStatusVisual[item.status]" />
      <StatusLabel v-if="item.review" :status="knowledgeTrustVisual.needsReview" />
      <StatusLabel v-if="item.possiblyStale" :status="knowledgeTrustVisual.possiblyStale" />
    </template>
    <template #meta>
      <span v-if="item.projectName">{{ item.projectName }} · </span>
      <time :datetime="item.updatedAt" :title="formatDate(item.updatedAt)">{{
        t("common.updated", { value: formatRelative(item.updatedAt) })
      }}</time>
      <template v-if="item.evidence">
        ·
        <button
          type="button"
          class="knowledge-row__evidence"
          :aria-label="
            t('knowledge.confirmedTimesContradictedTimesView', {
              confirmed: item.evidence.confirmed,
              contradicted: item.evidence.contradicted,
            })
          "
          @click="emit('action', 'history', item)"
        >
          {{
            t("knowledge.confirmedContradicted", {
              confirmed: item.evidence.confirmed,
              contradicted: item.evidence.contradicted,
            })
          }}
        </button>
      </template>
      <template v-if="item.lastConfirmedAt">
        ·
        <time :datetime="item.lastConfirmedAt" :title="formatDate(item.lastConfirmedAt)">{{
          t("knowledge.confirmedValidAt", { value: formatRelative(item.lastConfirmedAt) })
        }}</time>
      </template>
    </template>
    <p v-if="item.review" class="knowledge-row__trust knowledge-row__trust--danger">
      {{
        t("knowledge.aSessionReportedThatThis", {
          value: formatRelative(item.review.at),
        })
      }}
    </p>
    <p v-else-if="item.possiblyStale" class="knowledge-row__trust">
      {{
        t("knowledge.changed", {
          sessionTitle: item.possiblyStale.sessionTitle,
          when: formatRelative(item.possiblyStale.completedAt),
        })
      }}
      <code>{{ item.possiblyStale.paths.join(t("common.listSeparator")) }}</code
      ><template v-if="item.possiblyStale.sessionCount > 1">{{
        t("knowledge.sessionsChangedThesePathsSince", { sessionCount: item.possiblyStale.sessionCount })
      }}</template
      >{{ t("common.sentenceEnd") }}
    </p>
    <p :class="['knowledge-row__body', { 'is-expanded': expanded }]">{{ item.body }}</p>
    <button v-if="item.body.length > 180" type="button" class="knowledge-row__more" @click="expanded = !expanded">
      {{ expanded ? t("knowledge.collapse") : t("knowledge.showFullText") }}
    </button>
    <div v-if="item.tags.length || item.references.length || item.appliesTo.length" class="knowledge-row__chips">
      <UiLabel v-for="tag in item.tags" :key="`tag-${tag}`">#{{ tag }}</UiLabel>
      <code v-for="reference in item.references" :key="`ref-${reference}`" class="knowledge-row__ref">{{
        reference
      }}</code>
      <code
        v-for="pattern in item.appliesTo"
        :key="`applies-${pattern}`"
        class="knowledge-row__ref"
        :title="t('knowledge.appliesToPattern', { pattern })"
        >{{ t("knowledge.appliesTo", { pattern }) }}</code
      >
    </div>
    <template #trailing>
      <UiActionMenu
        :label="t('knowledge.more')"
        hide-label-on-mobile
        variant="button"
        size="sm"
        align="end"
        :items="actions"
        @select="emit('action', $event, item)"
      />
    </template>
  </UiBoxRow>
</template>

<style scoped>
.knowledge-row__evidence {
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font: inherit;
  cursor: pointer;
}

.knowledge-row__evidence:hover {
  text-decoration: underline;
}

.knowledge-row__trust {
  margin-top: var(--space-2);
  color: var(--attention);
  font-size: var(--text-sm);
  line-height: 1.6;
}

.knowledge-row__trust--danger {
  color: var(--danger);
}

.knowledge-row__trust code {
  overflow-wrap: anywhere;
}

.knowledge-row__body {
  display: -webkit-box;
  margin-top: var(--space-2);
  overflow: hidden;
  color: var(--fg);
  font-size: var(--text-sm);
  line-height: 1.6;
  white-space: pre-line;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.knowledge-row__body.is-expanded {
  display: block;
}

.knowledge-row__more {
  margin-top: var(--space-1);
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font-size: var(--text-xs);
}

.knowledge-row__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
  margin-top: var(--space-2);
}

.knowledge-row__ref {
  padding: 1px 6px;
  border-radius: var(--radius);
  background: var(--bg-muted);
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}

.tone-accent {
  color: var(--accent);
}
.tone-done {
  color: var(--done);
}
.tone-attention {
  color: var(--attention);
}
.tone-success {
  color: var(--success);
}
.tone-neutral {
  color: var(--fg-muted);
}
</style>
