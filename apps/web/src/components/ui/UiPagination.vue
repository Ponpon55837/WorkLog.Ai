<script setup lang="ts">
import { ChevronLeft, ChevronRight } from "lucide-vue-next";
import type { PageInfo } from "@work-intelligence/core";
import { listPageSizeOptions, type ListPageSize } from "../../utils/labels";
import UiButton from "./UiButton.vue";
import UiSelect from "./UiSelect.vue";

/** The single pagination control: summary, page-size select (10/20/50/100/All) and prev/next. */
defineProps<{ pageInfo: PageInfo; sizeLabel: string }>();
const pageSize = defineModel<ListPageSize>("pageSize", { required: true });
const emit = defineEmits<{ page: [page: number] }>();

const sizeOptions = listPageSizeOptions.map((option) => ({ value: option.value, label: option.label }));
</script>

<template>
  <div class="ui-pagination">
    <span class="ui-pagination__summary">
      顯示 {{ pageInfo.from }}–{{ pageInfo.to }}，共 {{ pageInfo.total }} 筆
      <span v-if="pageInfo.truncated"> · All 已限制每頁 {{ pageInfo.pageSize }} 筆</span>
    </span>
    <span class="ui-pagination__size">
      每頁
      <UiSelect v-model="pageSize" :options="sizeOptions" :label="sizeLabel" size="sm" />
    </span>
    <span v-if="pageInfo.totalPages > 1" class="ui-pagination__pages">
      <UiButton size="sm" :icon="ChevronLeft" :disabled="!pageInfo.hasPrevious" @click="emit('page', pageInfo.page - 1)">上一頁</UiButton>
      <span>第 {{ pageInfo.page }} / {{ pageInfo.totalPages }} 頁</span>
      <UiButton size="sm" :trailing-icon="ChevronRight" :disabled="!pageInfo.hasNext" @click="emit('page', pageInfo.page + 1)">下一頁</UiButton>
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
