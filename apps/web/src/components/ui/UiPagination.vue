<script setup lang="ts">
import { computed, ref } from "vue";
import { ChevronLeft, ChevronRight } from "lucide-vue-next";
import type { PageInfo } from "@work-intelligence/core";
import { listPageSizeOptions, type ListPageSize } from "../../utils/labels";
import UiButton from "./UiButton.vue";
import UiSelect from "./UiSelect.vue";
import { t } from "../../i18n";

/** The single pagination control: summary, page-size select (10/20/50/100/All) and prev/next. */
const props = defineProps<{
  pageInfo: PageInfo;
  sizeLabel: string;
  pageSizeOptions?: readonly { value: ListPageSize; label: string }[];
}>();
const emit = defineEmits<{ page: [page: number] }>();
const pageSize = defineModel<ListPageSize>("pageSize", { required: true });
const root = ref<HTMLElement | null>(null);

const sizeOptions = computed(
  () => props.pageSizeOptions ?? listPageSizeOptions.map((option) => ({ value: option.value, label: option.label })),
);

/** Changing page from the footer brings the top of the list back into view instead of leaving the user at the bottom. */
function goTo(page: number): void {
  emit("page", page);
  const list = root.value?.closest<HTMLElement>(".ui-box");
  const scroller = list?.closest<HTMLElement>("main");
  if (list && scroller && list.getBoundingClientRect().top < scroller.getBoundingClientRect().top) {
    list.scrollIntoView({ block: "start" });
  }
}
</script>

<template>
  <div ref="root" class="ui-pagination">
    <span class="ui-pagination__summary">
      {{ t("ui.showingOf", { from: pageInfo.from, to: pageInfo.to, total: pageInfo.total }) }}
      <span v-if="pageInfo.truncated"> {{ t("ui.allIsCappedAtPer", { pageSize: pageInfo.pageSize }) }}</span>
    </span>
    <span class="ui-pagination__size">
      {{ t("ui.perPage") }}
      <UiSelect v-model="pageSize" :options="sizeOptions" :label="sizeLabel" size="sm" />
    </span>
    <span v-if="pageInfo.totalPages > 1" class="ui-pagination__pages">
      <UiButton size="sm" :icon="ChevronLeft" :disabled="!pageInfo.hasPrevious" @click="goTo(pageInfo.page - 1)">{{
        t("ui.previousPage")
      }}</UiButton>
      <span>{{ t("ui.page", { page: pageInfo.page, totalPages: pageInfo.totalPages }) }}</span>
      <UiButton
        size="sm"
        :trailing-icon="ChevronRight"
        :disabled="!pageInfo.hasNext"
        @click="goTo(pageInfo.page + 1)"
        >{{ t("ui.nextPage") }}</UiButton
      >
    </span>
  </div>
</template>

<style scoped>
.ui-pagination {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-4);
  width: 100%;
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.ui-pagination__size,
.ui-pagination__pages {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.ui-pagination__summary {
  flex: 1 1 auto;
}
</style>
