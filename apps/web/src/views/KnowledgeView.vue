<script setup lang="ts">
import { computed } from "vue";
import type {
  KnowledgeKind,
  KnowledgeRecord,
  KnowledgeStatus,
  PageInfo,
  ProjectRecord
} from "@work-intelligence/core";
import VirtualList from "../components/VirtualList.vue";

type ListPageSize = 10 | 20 | 50 | 100 | "all";

const props = defineProps<{
  knowledgeItems: readonly KnowledgeRecord[];
  knowledgeProjects: readonly ProjectRecord[];
  knowledgePageInfo: PageInfo;
  knowledgeQuery: string;
  knowledgeKind: KnowledgeKind | "";
  knowledgeProjectId: string;
  knowledgeStatus: KnowledgeStatus;
  knowledgeLoading: boolean;
  knowledgeError: string;
  knowledgeKindLabels: Readonly<Record<KnowledgeKind, string>>;
  knowledgeStatusLabels: Readonly<Record<KnowledgeStatus, string>>;
  knowledgePageSize: ListPageSize;
  listPageSizeOptions: readonly { value: ListPageSize; label: string }[];
  formatDate: (value: string) => string;
  knowledgeKindLabel: (value: unknown) => string;
  knowledgeStatusLabel: (value: unknown) => string;
}>();

const emit = defineEmits<{
  "update:knowledgeQuery": [value: string];
  "update:knowledgeKind": [value: KnowledgeKind | ""];
  "update:knowledgeProjectId": [value: string];
  "update:knowledgeStatus": [value: KnowledgeStatus];
  "update:knowledgePageSize": [value: ListPageSize];
  load: [reset?: boolean];
  openKnowledgeSession: [item: KnowledgeRecord];
  openKnowledgeHistory: [item: KnowledgeRecord];
  openKnowledgeEditor: [item: KnowledgeRecord];
  setKnowledgeStatus: [item: KnowledgeRecord, status: KnowledgeStatus];
  changeKnowledgePage: [page: number];
  changeKnowledgePageSize: [event: Event];
}>();

const knowledgeQueryModel = computed({
  get: () => props.knowledgeQuery,
  set: (value: string) => emit("update:knowledgeQuery", value)
});
const knowledgeKindModel = computed({
  get: () => props.knowledgeKind,
  set: (value: KnowledgeKind | "") => emit("update:knowledgeKind", value)
});
const knowledgeProjectIdModel = computed({
  get: () => props.knowledgeProjectId,
  set: (value: string) => emit("update:knowledgeProjectId", value)
});
const knowledgeStatusModel = computed({
  get: () => props.knowledgeStatus,
  set: (value: KnowledgeStatus) => emit("update:knowledgeStatus", value)
});
const knowledgePageSizeModel = computed({
  get: () => props.knowledgePageSize,
  set: (value: ListPageSize) => emit("update:knowledgePageSize", value)
});
</script>

<template>
  <section class="page-section knowledge-page">
    <div class="section-intro knowledge-intro">
      <div>
        <div class="eyebrow">EXPLICIT KNOWLEDGE</div>
        <h2>把已確認的經驗，留給下一次工作。</h2>
        <p>Knowledge 只接受 Agent 明確提交的內容，不會自行讀取 source 或用猜測取代證據。</p>
      </div>
      <div class="tracked-summary"><strong>{{ knowledgePageInfo.total }}</strong><span>筆目前可用知識</span></div>
    </div>

    <form class="knowledge-tools" @submit.prevent="emit('load', true)">
      <label class="search-box knowledge-search-box">
        <span>⌕</span>
        <input v-model="knowledgeQueryModel" type="search" placeholder="搜尋標題、內容、標籤或參考" />
      </label>
      <label class="filter-field">
        <span>專案</span>
        <select v-model="knowledgeProjectIdModel" aria-label="依專案篩選 Knowledge">
          <option value="">所有記錄中專案</option>
          <option v-for="project in knowledgeProjects" :key="project.id" :value="project.id">{{ project.name }}</option>
        </select>
      </label>
      <label class="filter-field">
        <span>類型</span>
        <select v-model="knowledgeKindModel" aria-label="依類型篩選 Knowledge">
          <option value="">所有類型</option>
          <option v-for="(label, kind) in knowledgeKindLabels" :key="kind" :value="kind">{{ label }}</option>
        </select>
      </label>
      <label class="filter-field">
        <span>狀態</span>
        <select v-model="knowledgeStatusModel" aria-label="依狀態篩選 Knowledge">
          <option v-for="(label, status) in knowledgeStatusLabels" :key="status" :value="status">{{ label }}</option>
        </select>
      </label>
      <button class="filter-button" type="submit" :disabled="knowledgeLoading">{{ knowledgeLoading ? '整理中…' : '套用篩選' }}</button>
    </form>

    <div v-if="knowledgeError" class="alert error-alert" role="alert">{{ knowledgeError }}</div>
    <section v-if="knowledgeLoading" class="loading-state knowledge-loading">
      <div class="spinner"></div>
      <p>正在載入已確認的工作知識…</p>
    </section>
    <section v-else class="panel knowledge-panel">
      <div class="list-heading knowledge-heading"><span>{{ knowledgePageInfo.total }} 筆{{ knowledgeStatus === 'active' ? '目前使用中' : '已封存' }} Knowledge</span><span>維護</span></div>
      <VirtualList :items="knowledgeItems" :enabled="knowledgePageSize === 'all'" aria-label="工作知識清單">
        <template #default="{ item }">
          <article class="knowledge-row">
            <div :class="['knowledge-kind-mark', `knowledge-kind-${item.kind}`]">{{ item.kind.slice(0, 1).toUpperCase() }}</div>
            <div class="knowledge-body">
              <div class="knowledge-title"><strong>{{ item.title }}</strong><span class="knowledge-kind-label">{{ knowledgeKindLabel(item.kind) }}</span><span :class="['knowledge-status-label', `knowledge-status-${item.status}`]">{{ knowledgeStatusLabel(item.status) }}</span></div>
              <p>{{ item.body }}</p>
              <div class="knowledge-meta">
                <span v-if="item.projectName">{{ item.projectName }}</span>
                <span v-for="tag in item.tags" :key="`${item.id}-${tag}`" class="knowledge-tag">#{{ tag }}</span>
                <button v-if="item.sessionId" class="text-button knowledge-source-button" type="button" @click="emit('openKnowledgeSession', item)">查看來源 Session ↗</button>
              </div>
              <div v-if="item.references.length" class="knowledge-references"><code v-for="reference in item.references" :key="`${item.id}-${reference}`">{{ reference }}</code></div>
            </div>
            <div class="knowledge-row-actions">
              <time>{{ formatDate(item.updatedAt) }}</time>
              <button class="text-button" type="button" @click="emit('openKnowledgeHistory', item)">變更紀錄</button>
              <button class="text-button" type="button" @click="emit('openKnowledgeEditor', item)">編輯</button>
              <button class="text-button knowledge-archive-button" type="button" @click="emit('setKnowledgeStatus', item, item.status === 'active' ? 'archived' : 'active')">{{ item.status === 'active' ? '封存' : '恢復' }}</button>
            </div>
          </article>
        </template>
      </VirtualList>
      <div v-if="knowledgeItems.length === 0" class="empty-state large-empty"><div class="empty-icon">✦</div><strong>{{ knowledgeStatus === 'active' ? '還沒有已確認的 Knowledge' : '沒有已封存的 Knowledge' }}</strong><p>{{ knowledgeStatus === 'active' ? 'Agent 使用 work_record_knowledge 提交 decision、pattern、gotcha、procedure 或 skill 後，內容會出現在這裡。' : '封存只會停止它出現在預設搜尋與 Graph 中，不會刪除原始記錄。' }}</p></div>
      <div class="pagination-bar list-pagination-bar">
        <span class="pagination-summary">顯示 {{ knowledgePageInfo.from }}–{{ knowledgePageInfo.to }}，共 {{ knowledgePageInfo.total }} 筆<span v-if="knowledgePageInfo.truncated" class="pagination-truncated"> · All 已限制每頁 {{ knowledgePageInfo.pageSize }} 筆</span></span>
        <label class="pagination-page-size"><span>每頁</span><select v-model="knowledgePageSizeModel" aria-label="Knowledge 每頁筆數" @change="emit('changeKnowledgePageSize', $event)"><option v-for="option in listPageSizeOptions" :key="String(option.value)" :value="option.value">{{ option.label }}</option></select></label>
        <div v-if="knowledgePageInfo.totalPages > 1" class="pagination-controls">
          <button class="pagination-button" type="button" :disabled="!knowledgePageInfo.hasPrevious" @click="emit('changeKnowledgePage', knowledgePageInfo.page - 1)">上一頁</button>
          <span>第 {{ knowledgePageInfo.page }} / {{ knowledgePageInfo.totalPages }} 頁</span>
          <button class="pagination-button" type="button" :disabled="!knowledgePageInfo.hasNext" @click="emit('changeKnowledgePage', knowledgePageInfo.page + 1)">下一頁</button>
        </div>
        <span v-else class="pagination-current">共 {{ knowledgePageInfo.total }} 筆</span>
      </div>
    </section>
  </section>
</template>
