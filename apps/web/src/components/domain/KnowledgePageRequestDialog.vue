<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ProjectRecord } from "@work-intelligence/core";
import { useToast } from "../../composables/useToast";
import { useKnowledgePagesStore } from "../../stores/knowledge-pages";
import { errorMessage } from "../../utils/format";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import UiField from "../ui/UiField.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiSelect from "../ui/UiSelect.vue";
import UiTextInput from "../ui/UiTextInput.vue";
import UiTextarea from "../ui/UiTextarea.vue";
import { t } from "../../i18n";

const props = defineProps<{ open: boolean; projects: readonly ProjectRecord[]; defaultProjectId?: string }>();
const emit = defineEmits<{ close: [] }>();

const slugPattern = /^[a-z0-9][a-z0-9-]{1,39}$/;

const pagesStore = useKnowledgePagesStore();
const { showToast } = useToast();

const form = ref({ slug: "", title: "", question: "" });
const projectId = ref("");
const saving = ref(false);
const error = ref("");

const project = computed(() => props.projects.find((item) => item.id === projectId.value));
const projectOptions = computed(() => [
  { value: "", label: t("outstanding.chooseAProjectFirst") },
  ...props.projects.map((item) => ({ value: item.id, label: item.name })),
]);

function initialProjectId(): string {
  const preferred = props.projects.find((item) => item.id === props.defaultProjectId);
  return (preferred ?? (props.projects.length === 1 ? props.projects[0] : undefined))?.id ?? "";
}

function close(): void {
  if (!saving.value) emit("close");
}

async function submit(): Promise<void> {
  if (!project.value) {
    error.value = t("outstanding.chooseAProjectFirst");
    return;
  }
  const slug = form.value.slug.trim();
  if (!slugPattern.test(slug)) {
    error.value = t("knowledge.slugsNeed240Lowercase");
    return;
  }
  saving.value = true;
  error.value = "";
  try {
    const result = await pagesStore.requestUpdate({
      projectRoot: project.value.rootPath,
      slug,
      title: form.value.title.trim(),
      question: form.value.question.trim(),
    });
    if (result.outcome !== "knowledge_page_update_requested") {
      error.value = result.reason ?? t("knowledge.couldNotCreateTheKnowledge");
      return;
    }
    showToast(t("knowledge.createdAndAskedTheAgent", { title: result.page.title }), "success");
    saving.value = false;
    emit("close");
  } catch (caught) {
    error.value = errorMessage(caught, t("knowledge.couldNotCreateTheKnowledge"));
  } finally {
    saving.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      form.value = { slug: "", title: "", question: "" };
      projectId.value = initialProjectId();
      error.value = "";
    }
  },
);
</script>

<template>
  <UiDialog
    :open="open"
    :title="t('knowledge.customKnowledgePage')"
    :description="
      t('knowledge.theAgentWritesThePage', {
        value: project?.name ?? t('common.trackedProjects'),
      })
    "
    :busy="saving"
    @close="close"
  >
    <form id="knowledge-page-request-form" class="page-request" @submit.prevent="submit">
      <UiFlash v-if="error" tone="danger">{{ error }}</UiFlash>
      <UiField v-if="projects.length > 1" :label="t('knowledge.createInProject')"
        ><UiSelect v-model="projectId" :options="projectOptions" :label="t('knowledge.createInProject')"
      /></UiField>
      <UiField :label="t('knowledge.title')"
        ><UiTextInput v-model="form.title" :maxlength="80" required autofocus
      /></UiField>
      <UiField :label="t('knowledge.slug')" :hint="t('knowledge.usedInTheUrlAnd')">
        <UiTextInput v-model="form.slug" :maxlength="40" required mono />
      </UiField>
      <UiField :label="t('knowledge.theQuestionThisPageAnswers')">
        <UiTextarea v-model="form.question" :rows="3" :maxlength="300" required />
      </UiField>
    </form>
    <template #footer>
      <UiButton :disabled="saving" @click="close">{{ t("common.cancel") }}</UiButton>
      <UiButton variant="primary" type="submit" form="knowledge-page-request-form" :loading="saving">{{
        t("knowledge.createAndRequestWriting")
      }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.page-request {
  display: grid;
  gap: var(--space-4);
}
</style>
