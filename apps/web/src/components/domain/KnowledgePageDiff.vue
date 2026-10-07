<script setup lang="ts">
import { computed } from "vue";
import type { KnowledgePageSection } from "@work-intelligence/core";
import { diffKnowledgePages, type LineDiffKind, type SectionDiffStatus } from "../../utils/knowledge-page-diff";
import UiFlash from "../ui/UiFlash.vue";
import UiLabel from "../ui/UiLabel.vue";
import { t } from "../../i18n";

/** Read-only comparison of one page version against the version before it, section by section. */
const props = defineProps<{
  previousVersion: number;
  previous: readonly KnowledgePageSection[];
  current: readonly KnowledgePageSection[];
}>();

const SHORT_ID_LENGTH = 8;
const LINE_MARKS: Record<LineDiffKind, string> = { same: " ", added: "+", removed: "−" };
// Screen readers get the line kind as text; the +/− marks and colours are visual only.
const lineKindLabels: Record<LineDiffKind, () => string> = {
  same: () => "",
  added: () => t("knowledge.diffLineAdded"),
  removed: () => t("knowledge.diffLineRemoved"),
};
const statusLabels: Record<SectionDiffStatus, () => string> = {
  added: () => t("knowledge.diffSectionAdded"),
  removed: () => t("knowledge.diffSectionRemoved"),
  changed: () => t("knowledge.diffSectionChanged"),
  unchanged: () => t("knowledge.diffSectionUnchanged"),
};
const statusTones = { added: "success", removed: "danger", changed: "accent", unchanged: "neutral" } as const;

const diff = computed(() => diffKnowledgePages(props.previous, props.current));
const identical = computed(() => diff.value.sections.every((section) => section.status === "unchanged"));

function shortIds(ids: readonly string[]): string {
  return ids.map((id) => id.slice(0, SHORT_ID_LENGTH)).join(t("knowledge.semicolon"));
}
</script>

<template>
  <div class="page-diff">
    <UiFlash tone="accent">
      {{
        identical
          ? t("knowledge.comparisonIdentical", { previous: previousVersion })
          : t("knowledge.comparisonSummary", {
              previous: previousVersion,
              added: diff.added,
              removed: diff.removed,
              changed: diff.changed,
            })
      }}
    </UiFlash>

    <section v-for="(section, index) in diff.sections" :key="`${index}-${section.heading}`" class="page-diff__section">
      <h3>
        {{ section.heading }}
        <UiLabel :tone="statusTones[section.status]">{{ statusLabels[section.status]() }}</UiLabel>
      </h3>
      <ul v-if="section.lines.length > 0" class="page-diff__lines">
        <li v-for="(line, lineIndex) in section.lines" :key="lineIndex" :class="`page-diff__line--${line.kind}`">
          <span class="page-diff__mark" aria-hidden="true">{{ LINE_MARKS[line.kind] }}</span>
          <span v-if="line.kind !== 'same'" class="sr-only">{{ lineKindLabels[line.kind]() }}</span>
          <span>{{ line.text }}</span>
        </li>
      </ul>
      <p v-if="section.addedSourceIds.length > 0" class="page-diff__sources">
        {{
          t("knowledge.diffSourcesAdded", {
            count: section.addedSourceIds.length,
            ids: shortIds(section.addedSourceIds),
          })
        }}
      </p>
      <p v-if="section.removedSourceIds.length > 0" class="page-diff__sources">
        {{
          t("knowledge.diffSourcesRemoved", {
            count: section.removedSourceIds.length,
            ids: shortIds(section.removedSourceIds),
          })
        }}
      </p>
    </section>
  </div>
</template>

<style scoped>
.page-diff__section {
  padding-block: var(--space-3);
  border-bottom: 1px solid var(--border-muted);
}

.page-diff__section h3 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-md);
  font-weight: 600;
}

.page-diff__lines {
  margin: var(--space-2) 0 0;
  padding: 0;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius);
  list-style: none;
  font-size: var(--text-sm);
  line-height: 1.6;
  overflow: hidden;
}

.page-diff__lines li {
  display: flex;
  gap: var(--space-2);
  padding-inline: var(--space-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.page-diff__mark {
  flex: none;
  width: 1ch;
  font-family: var(--font-mono);
  font-weight: 600;
}

.page-diff__line--same {
  color: var(--fg-muted);
}

.page-diff__line--added {
  background: var(--success-soft);
  color: var(--fg);
}

.page-diff__line--added .page-diff__mark {
  color: var(--success);
}

.page-diff__line--removed {
  background: var(--danger-soft);
  color: var(--fg);
}

.page-diff__line--removed .page-diff__mark {
  color: var(--danger);
}

.page-diff__sources {
  margin-top: var(--space-1);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}
</style>
