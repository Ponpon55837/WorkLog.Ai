<script setup lang="ts">
import { ref, watch } from "vue";
import { Plus, Trash2 } from "lucide-vue-next";
import { KNOWLEDGE_PAGE_INSUFFICIENT, type KnowledgePageRecord } from "@work-intelligence/core";
import { useToast } from "../../composables/useToast";
import { useKnowledgePagesStore } from "../../stores/knowledge-pages";
import { errorMessage } from "../../utils/format";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import UiField from "../ui/UiField.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiTextInput from "../ui/UiTextInput.vue";
import UiTextarea from "../ui/UiTextarea.vue";
import { t } from "../../i18n";

interface SectionDraft {
  heading: string;
  content: string;
  /** Session ids, one per line or comma separated. */
  sources: string;
}

/** A manual edit of a standing page; saving keeps it as a new version, like an Agent update. */
const props = defineProps<{ open: boolean; page: KnowledgePageRecord | null }>();
const emit = defineEmits<{ close: [] }>();

const maxSections = 12;

const pagesStore = useKnowledgePagesStore();
const { showToast } = useToast();

const title = ref("");
const sections = ref<SectionDraft[]>([]);
const saving = ref(false);
const error = ref("");

function splitIds(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,，、]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function addSection(): void {
  sections.value.push({ heading: "", content: "", sources: "" });
}

function removeSection(index: number): void {
  sections.value.splice(index, 1);
}

function close(): void {
  if (!saving.value) emit("close");
}

async function save(): Promise<void> {
  const page = props.page;
  if (!page) return;
  const payload = sections.value.map((section) => ({
    heading: section.heading.trim(),
    content: section.content.trim(),
    sourceSessionIds: splitIds(section.sources),
  }));
  if (payload.length === 0 || payload.some((section) => !section.heading || !section.content)) {
    error.value = t("knowledge.everySectionNeedsATitle");
    return;
  }
  if (
    payload.some((section) => section.sourceSessionIds.length === 0 && section.content !== KNOWLEDGE_PAGE_INSUFFICIENT)
  ) {
    error.value = t("knowledge.everySectionMustListIts", {
      KNOWLEDGE_PAGE_INSUFFICIENT,
    });
    return;
  }
  saving.value = true;
  error.value = "";
  try {
    const result = await pagesStore.updatePage({
      pageId: page.id,
      title: title.value.trim() || undefined,
      sections: payload,
    });
    if (result.outcome === "invalid_sources") {
      error.value = t("knowledge.theseSourceSessionsDoNot", {
        value: result.sessionIds.join(t("common.listSeparator")),
      });
      return;
    }
    if (result.outcome !== "knowledge_page_updated") {
      error.value = result.reason ?? t("knowledge.couldNotSaveTheKnowledge");
      return;
    }
    showToast(t("knowledge.savedAsVersion", { version: result.page.version }), "success");
    saving.value = false;
    emit("close");
  } catch (caught) {
    error.value = errorMessage(caught, t("knowledge.couldNotSaveTheKnowledge"));
  } finally {
    saving.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open || !props.page) return;
    title.value = props.page.title;
    sections.value = props.page.sections.map((section) => ({
      heading: section.heading,
      content: section.content,
      sources: section.sourceSessionIds.join("\n"),
    }));
    if (sections.value.length === 0) addSection();
    error.value = "";
  },
);
</script>

<template>
  <UiDialog
    :open="open"
    :title="t('knowledge.editKnowledgePage')"
    :description="t('knowledge.savingCreatesANewVersion')"
    size="lg"
    :busy="saving"
    @close="close"
  >
    <form id="knowledge-page-editor-form" class="page-editor" @submit.prevent="save">
      <UiFlash v-if="error" tone="danger">{{ error }}</UiFlash>
      <UiField :label="t('knowledge.title')"><UiTextInput v-model="title" :maxlength="80" required /></UiField>
      <fieldset v-for="(section, index) in sections" :key="index" class="page-editor__section">
        <legend>{{ t("knowledge.section", { value: index + 1 }) }}</legend>
        <div class="page-editor__heading">
          <UiField :label="t('knowledge.sectionTitle')"
            ><UiTextInput v-model="section.heading" :maxlength="120" required
          /></UiField>
          <UiIconButton
            :icon="Trash2"
            :label="t('knowledge.removeSection', { value: index + 1 })"
            :disabled="sections.length === 1"
            @click="removeSection(index)"
          />
        </div>
        <UiField :label="t('common.body')"
          ><UiTextarea v-model="section.content" :rows="4" :maxlength="4000" required
        /></UiField>
        <UiField :label="t('knowledge.sourceSessionId')" :hint="t('knowledge.onePerLineWithoutA')">
          <UiTextarea v-model="section.sources" :rows="2" mono />
        </UiField>
      </fieldset>
      <UiButton :icon="Plus" :disabled="sections.length >= maxSections" @click="addSection">{{
        t("knowledge.addSection")
      }}</UiButton>
    </form>
    <template #footer>
      <UiButton :disabled="saving" @click="close">{{ t("common.cancel") }}</UiButton>
      <UiButton variant="primary" type="submit" form="knowledge-page-editor-form" :loading="saving">{{
        t("knowledge.saveNewVersion")
      }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.page-editor {
  display: grid;
  gap: var(--space-4);
}

.page-editor__section {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding: var(--space-3);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius);
}

.page-editor__section legend {
  padding-inline: var(--space-1);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.page-editor__heading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: var(--space-2);
}
</style>
