<script setup lang="ts">
import { computed, ref } from "vue";
import { ExternalLink } from "lucide-vue-next";
import UiButton from "../ui/UiButton.vue";
import UiDisclosure from "../ui/UiDisclosure.vue";
import { t } from "../../i18n";

const props = defineProps<{ sessionIds: readonly string[]; titles: ReadonlyMap<string, string> }>();
const emit = defineEmits<{ open: [sessionId: string] }>();

const previewLimit = 3;

const showAll = ref(false);

const shownIds = computed(() => (showAll.value ? props.sessionIds : props.sessionIds.slice(0, previewLimit)));
</script>

<template>
  <UiDisclosure class="page-sources" :title="t('knowledge.sourcesCount', { count: sessionIds.length })" open>
    <ul class="page-sources__list">
      <li v-for="sessionId in shownIds" :key="sessionId">
        <UiButton
          size="sm"
          variant="invisible"
          truncate
          :icon="ExternalLink"
          :disabled="!titles.has(sessionId)"
          :title="titles.has(sessionId) ? undefined : t('knowledge.theSourceSessionIsVoided')"
          @click="emit('open', sessionId)"
          >{{ titles.get(sessionId) ?? `Session ${sessionId.slice(0, 8)}` }}</UiButton
        >
      </li>
    </ul>
    <UiButton
      v-if="sessionIds.length > previewLimit"
      class="page-sources__toggle"
      variant="link"
      size="sm"
      :aria-expanded="showAll"
      @click="showAll = !showAll"
      >{{
        showAll
          ? t("knowledge.showFewerSources", { count: previewLimit })
          : t("knowledge.showAllSources", { count: sessionIds.length })
      }}</UiButton
    >
  </UiDisclosure>
</template>

<style scoped>
.page-sources {
  margin-top: var(--space-2);
}

.page-sources__list {
  display: grid;
  margin: 0;
  padding: var(--space-1) var(--space-2);
  list-style: none;
}

.page-sources__list li {
  display: flex;
  min-width: 0;
}

.page-sources__list li :deep(.ui-button) {
  min-width: 0;
  max-width: 100%;
}

.page-sources__toggle {
  margin: 0 var(--space-3) var(--space-2);
}
</style>
