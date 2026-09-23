<script setup lang="ts">
import { useKnowledge } from "../composables/useKnowledge";
import { knowledgeKindLabels, knowledgeStatusLabels } from "../utils/labels";
import BaseModal from "./BaseModal.vue";

const { knowledgeEditor, knowledgeEditorForm, knowledgeEditorSaving, knowledgeEditorError, closeKnowledgeEditor, saveKnowledge } = useKnowledge();
</script>

<template>
  <BaseModal :open="Boolean(knowledgeEditor)" ariaLabel="編輯 Knowledge" panel-class="knowledge-editor-modal" @close="closeKnowledgeEditor">
    <template v-if="knowledgeEditor">
      <header class="detail-modal-header">
        <div>
          <div class="eyebrow">KNOWLEDGE MAINTENANCE</div>
          <p class="knowledge-editor-project">{{ knowledgeEditor.projectName ?? 'Tracked project' }}</p>
        </div>
        <button class="close-button" type="button" aria-label="關閉 Knowledge 編輯器" :disabled="knowledgeEditorSaving" @click="closeKnowledgeEditor">×</button>
      </header>
      <form class="detail-modal-content knowledge-editor-content" @submit.prevent="saveKnowledge">
        <h2>維護已確認的 Knowledge</h2>
        <p class="knowledge-editor-note">這裡只修改中央 registry 中的明確 Knowledge，不會讀取或修改來源 repo。</p>
        <div v-if="knowledgeEditorError" class="alert error-alert" role="alert">{{ knowledgeEditorError }}</div>
        <div class="knowledge-editor-grid">
          <label class="knowledge-editor-field knowledge-editor-title-field">
            <span>標題</span>
            <input v-model="knowledgeEditorForm.title" type="text" maxlength="300" required />
          </label>
          <label class="knowledge-editor-field">
            <span>類型</span>
            <select v-model="knowledgeEditorForm.kind">
              <option v-for="(label, kind) in knowledgeKindLabels" :key="kind" :value="kind">{{ label }}</option>
            </select>
          </label>
          <label class="knowledge-editor-field">
            <span>狀態</span>
            <select v-model="knowledgeEditorForm.status">
              <option v-for="(label, status) in knowledgeStatusLabels" :key="status" :value="status">{{ label }}</option>
            </select>
          </label>
        </div>
        <label class="knowledge-editor-field">
          <span>內容</span>
          <textarea v-model="knowledgeEditorForm.body" rows="8" maxlength="20000" required></textarea>
        </label>
        <div class="knowledge-editor-grid">
          <label class="knowledge-editor-field">
            <span>標籤</span>
            <input v-model="knowledgeEditorForm.tags" type="text" placeholder="以逗號分隔，例如：architecture, registry" />
          </label>
          <label class="knowledge-editor-field">
            <span>參考資料</span>
            <textarea v-model="knowledgeEditorForm.references" rows="3" placeholder="每行一個 reference"></textarea>
          </label>
        </div>
        <footer class="knowledge-editor-footer">
          <span>封存不會刪除記錄，只會從預設搜尋與 Graph 隱藏。</span>
          <div>
            <button class="text-button" type="button" :disabled="knowledgeEditorSaving" @click="closeKnowledgeEditor">取消</button>
            <button class="primary-button" type="submit" :disabled="knowledgeEditorSaving">{{ knowledgeEditorSaving ? '儲存中…' : '儲存變更' }}</button>
          </div>
        </footer>
      </form>
    </template>
  </BaseModal>
</template>
