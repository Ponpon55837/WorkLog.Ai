<script setup lang="ts">
import { ref, watch } from "vue";
import type { ProjectRecord } from "@work-intelligence/core";
import { useToast } from "../../composables/useToast";
import { useKnowledgePagesStore } from "../../stores/knowledge-pages";
import { errorMessage } from "../../utils/format";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";
import UiField from "../ui/UiField.vue";
import UiFlash from "../ui/UiFlash.vue";
import UiTextInput from "../ui/UiTextInput.vue";
import UiTextarea from "../ui/UiTextarea.vue";
import { t } from "../../i18n";

/** Creates a custom standing page (its own question) and asks the Agent to write it. */
const props = defineProps<{ open: boolean; project?: ProjectRecord }>();
const emit = defineEmits<{ close: [] }>();

const slugPattern = /^[a-z0-9][a-z0-9-]{1,39}$/;

const pagesStore = useKnowledgePagesStore();
const { showToast } = useToast();

const form = ref({ slug: "", title: "", question: "" });
const saving = ref(false);
const error = ref("");

function close(): void {
  if (!saving.value) emit("close");
}

async function submit(): Promise<void> {
  const project = props.project;
  if (!project) return;
  const slug = form.value.slug.trim();
  if (!slugPattern.test(slug)) {
    error.value = t("代稱需為 2–40 個小寫英文字母、數字或連字號，且以字母或數字開頭。");
    return;
  }
  saving.value = true;
  error.value = "";
  try {
    const result = await pagesStore.requestUpdate({
      projectRoot: project.rootPath,
      slug,
      title: form.value.title.trim(),
      question: form.value.question.trim(),
    });
    if (result.outcome !== "knowledge_page_update_requested") {
      error.value = result.reason ?? t("無法建立知識頁。");
      return;
    }
    showToast(t("已建立「{title}」並要求 Agent 撰寫。", { title: result.page.title }), "success");
    saving.value = false;
    emit("close");
  } catch (caught) {
    error.value = errorMessage(caught, t("無法建立知識頁。"));
  } finally {
    saving.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      form.value = { slug: "", title: "", question: "" };
      error.value = "";
    }
  },
);
</script>

<template>
  <UiDialog
    :open="open"
    :title="t('自訂知識頁')"
    :description="
      t('{value} · Agent 會依這個問題，從已記錄的 Session 撰寫並標示來源。', {
        value: project?.name ?? t('記錄中專案'),
      })
    "
    :busy="saving"
    @close="close"
  >
    <form id="knowledge-page-request-form" class="page-request" @submit.prevent="submit">
      <UiFlash v-if="error" tone="danger">{{ error }}</UiFlash>
      <UiField :label="t('標題')"><UiTextInput v-model="form.title" :maxlength="80" required autofocus /></UiField>
      <UiField :label="t('代稱')" :hint="t('網址與 Agent 使用的識別，例如 release-process')">
        <UiTextInput v-model="form.slug" :maxlength="40" required mono />
      </UiField>
      <UiField :label="t('這一頁要回答的問題')">
        <UiTextarea v-model="form.question" :rows="3" :maxlength="300" required />
      </UiField>
    </form>
    <template #footer>
      <UiButton :disabled="saving" @click="close">{{ t("取消") }}</UiButton>
      <UiButton variant="primary" type="submit" form="knowledge-page-request-form" :loading="saving">{{
        t("建立並要求撰寫")
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
