<script setup lang="ts">
import { useHandoffImport } from "../composables/useHandoffImport";
import { verificationLabels } from "../utils/labels";
import BaseModal from "./BaseModal.vue";

const {
  handoffImportPreview,
  handoffImportApplying,
  handoffImportError,
  importableHandoffs,
  selectedHandoffCount,
  isHandoffSelected,
  toggleHandoffSelection,
  selectAllHandoffs,
  clearHandoffSelection,
  handoffDecisionLabel,
  closeHandoffImport,
  applyHandoffImport
} = useHandoffImport();
</script>

<template>
  <BaseModal :open="Boolean(handoffImportPreview)" ariaLabel="Handoff import preview" panel-class="import-modal" backdrop-class="import-backdrop" @close="closeHandoffImport">
    <template v-if="handoffImportPreview">
      <header class="detail-modal-header">
        <div>
          <div class="eyebrow">HANDOFF IMPORT / PREVIEW</div>
          <h2>歷史 handoff 匯入預覽</h2>
          <p class="import-project-label">{{ handoffImportPreview.project.name }} · {{ handoffImportPreview.handoffDirectory }}</p>
        </div>
        <button class="close-button" type="button" aria-label="關閉匯入預覽" :disabled="handoffImportApplying" @click="closeHandoffImport">×</button>
      </header>
      <div class="detail-modal-content">
        <p class="import-description">先檢查系統找到的 handoff，再勾選要保存的項目。只有明確標示完成的文件可匯入；blocked、pending、僅規劃與缺少完成狀態的文件會保留在預覽中但不會自動建立 Session。</p>
        <div v-if="handoffImportError" class="alert error-alert" role="alert">{{ handoffImportError }}</div>
        <div class="import-summary-grid">
          <div><span>發現</span><strong>{{ handoffImportPreview.totals.discovered }}</strong></div>
          <div><span>可匯入</span><strong class="import-count-good">{{ handoffImportPreview.totals.eligible }}</strong></div>
          <div><span>已匯入</span><strong>{{ handoffImportPreview.totals.alreadyImported }}</strong></div>
          <div><span>略過／錯誤</span><strong>{{ handoffImportPreview.totals.excluded + handoffImportPreview.totals.errors }}</strong></div>
        </div>
        <div v-if="!handoffImportPreview.directoryFound" class="empty-state import-empty"><strong>找不到 handoff 目錄</strong><p>{{ handoffImportPreview.handoffDirectory }} 目前不存在或沒有可讀取的 Markdown 文件。</p></div>
        <div v-else class="import-list">
          <label v-for="item in handoffImportPreview.items" :key="item.sourcePath" :class="['import-item', `import-item-${item.decision}`]">
            <input type="checkbox" :checked="isHandoffSelected(item.sourcePath)" :disabled="item.decision !== 'eligible' || handoffImportApplying" @change="toggleHandoffSelection(item)" />
            <div class="import-item-copy">
              <div class="import-item-heading"><strong>{{ item.title }}</strong><span>{{ handoffDecisionLabel(item) }}</span></div>
              <code>{{ item.sourcePath }}</code>
              <p v-if="item.summaryPreview">{{ item.summaryPreview }}</p>
              <small>
                <span v-if="item.recordedDate">記錄日期 {{ item.recordedDate }} · </span>
                <span v-if="item.verificationStatus">Verification {{ verificationLabels[item.verificationStatus] }} · </span>
                {{ item.changedFilesStatus === 'detected' ? `${item.changedFiles.length} 個檔案` : item.changedFilesStatus === 'not_found' ? '尚未找到檔案 metadata' : '未讀取檔案 metadata' }}
                <span v-if="item.detail"> · {{ item.detail }}</span>
              </small>
            </div>
          </label>
        </div>
      </div>
      <footer class="import-modal-footer">
        <span>已選取 {{ selectedHandoffCount }} 個 handoff<span v-if="handoffImportPreview.truncated"> · 已達檔案上限，預覽被截斷</span></span>
        <div>
          <button class="text-button" type="button" :disabled="handoffImportApplying || importableHandoffs.length === 0" @click="selectAllHandoffs">全選可匯入</button>
          <button class="text-button" type="button" :disabled="handoffImportApplying || selectedHandoffCount === 0" @click="clearHandoffSelection">清除選取</button>
          <button class="primary-button" type="button" :disabled="handoffImportApplying || selectedHandoffCount === 0" @click="applyHandoffImport">{{ handoffImportApplying ? '匯入中…' : '套用選取' }}</button>
        </div>
      </footer>
    </template>
  </BaseModal>
</template>
