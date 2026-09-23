<script setup lang="ts">
import type {
  HandoffImportPreview,
  MetadataBackfillGap,
  MetadataBackfillPreview,
  MetadataBackfillRequest,
  ProjectRecord,
  ProjectStatus,
  ReportVerificationStatus
} from "@work-intelligence/core";

const props = defineProps<{
  trackedProjects: readonly ProjectRecord[];
  projects: readonly ProjectRecord[];
  projectName: string;
  projectRoot: string;
  addingProject: boolean;
  metadataBackfillPreview: MetadataBackfillPreview | null;
  metadataBackfillLoading: boolean;
  metadataBackfillError: string;
  metadataBackfillRequest: MetadataBackfillRequest | null;
  metadataBackfillRequestIsActive: boolean;
  metadataBackfillStatusLabels: Readonly<Record<MetadataBackfillRequest["status"], string>>;
  metadataBackfillRequestLoading: boolean;
  metadataBackfillRequestCreating: boolean;
  metadataBackfillRequestError: string;
  metadataBackfillInstruction: string;
  handoffImportLoading: boolean;
  handoffImportProjectId: string;
  statusLabels: Readonly<Record<ProjectStatus, string>>;
  statusDescriptions: Readonly<Record<ProjectStatus, string>>;
  verificationLabels: Readonly<Record<ReportVerificationStatus, string>>;
  formatDate: (value: string) => string;
  metadataGapLabel: (value: MetadataBackfillGap) => string;
}>();

const emit = defineEmits<{
  "update:projectName": [value: string];
  "update:projectRoot": [value: string];
  addProject: [];
  previewMetadataBackfill: [];
  openMetadataBackfillSession: [item: MetadataBackfillPreview["items"][number]];
  copyMetadataBackfillInstruction: [];
  cancelMetadataBackfillRequest: [];
  loadMetadataBackfillRequest: [];
  createMetadataBackfillRequest: [];
  previewHandoffs: [project: ProjectRecord];
  updateProjectStatus: [project: ProjectRecord, status: ProjectStatus];
}>();
</script>

<template>
  <section class="page-section">
    <div class="section-intro projects-intro">
      <div>
        <div class="eyebrow">PROJECT REGISTRY</div>
        <h2>你決定哪些專案值得被記住。</h2>
        <p>Registry 只存在中央 SQLite，不會把設定檔寫進任何專案 repo。</p>
      </div>
      <div class="tracked-summary"><strong>{{ trackedProjects.length }}</strong><span>個專案正在記錄</span></div>
    </div>

    <section class="panel add-project-panel">
      <div class="panel-heading compact">
        <div>
          <div class="eyebrow">ADD PROJECT</div>
          <h3>加入 registry</h3>
        </div>
        <span class="opt-in-label">加入後預設為未註冊</span>
      </div>
      <form class="project-form" @submit.prevent="emit('addProject')">
        <label>
          <span>專案名稱</span>
          <input :value="projectName" type="text" placeholder="例如：Assistant Console" @input="emit('update:projectName', ($event.target as HTMLInputElement).value)" />
        </label>
        <label class="path-field">
          <span>Workspace 根目錄</span>
          <input :value="projectRoot" type="text" placeholder="C:\\Users\\you\\project" @input="emit('update:projectRoot', ($event.target as HTMLInputElement).value)" />
        </label>
        <button class="primary-button" type="submit" :disabled="addingProject">{{ addingProject ? '加入中…' : '加入專案' }}</button>
      </form>
    </section>

    <section class="panel metadata-backfill-panel">
      <div class="metadata-backfill-heading">
        <div>
          <div class="eyebrow">AGENT FOLLOW-UPS</div>
          <h3>需要 Agent 回補的 Session</h3>
          <p>只列出已完成但缺少 Verification 或 changed-files metadata 的 tracked Session。這裡不會猜測，也不會自動寫回。</p>
        </div>
        <button class="outline-button" type="button" :disabled="metadataBackfillLoading" @click="emit('previewMetadataBackfill')">{{ metadataBackfillLoading ? '掃描中…' : '掃描 metadata 缺口' }}</button>
      </div>
      <div v-if="metadataBackfillError" class="alert error-alert metadata-backfill-alert" role="alert">{{ metadataBackfillError }}</div>
      <template v-if="metadataBackfillPreview">
        <div class="metadata-backfill-summary">
          <div><span>需要回補</span><strong>{{ metadataBackfillPreview.totals.needsBackfill }}</strong></div>
          <div><span>檔案 metadata</span><strong>{{ metadataBackfillPreview.totals.changedFilesMissing }}</strong></div>
          <div><span>Verification 缺漏</span><strong>{{ metadataBackfillPreview.totals.verificationMissing }}</strong></div>
          <div><span>明確未執行</span><strong>{{ metadataBackfillPreview.totals.verificationNotRun }}</strong></div>
        </div>
        <div v-if="metadataBackfillPreview.items.length" class="metadata-backfill-list">
          <article v-for="item in metadataBackfillPreview.items" :key="item.sessionId" class="metadata-backfill-item">
            <div class="metadata-backfill-item-copy">
              <strong>{{ item.title }}</strong>
              <span>{{ item.projectName }} · {{ formatDate(item.completedAt) }}</span>
              <small>{{ item.changedFilesCount }} 個檔案 · {{ item.changedFileChangesCount }} 筆生命週期紀錄 · {{ item.rawSnapshotCount }} 份 handoff snapshot</small>
            </div>
            <div class="metadata-backfill-gaps">
              <span v-for="gap in item.gaps" :key="gap" class="metadata-gap-chip">{{ metadataGapLabel(gap) }}</span>
              <span class="metadata-verification-chip">{{ verificationLabels[item.verificationStatus] }}</span>
            </div>
            <button class="text-button" type="button" @click="emit('openMetadataBackfillSession', item)">查看 Session</button>
          </article>
        </div>
        <div v-else class="metadata-backfill-empty"><strong>目前沒有待回補資料</strong><p>所有 tracked Session 都已提供必要的結構化 metadata。</p></div>
        <p v-if="metadataBackfillPreview.truncated" class="metadata-backfill-note">結果已達顯示上限，請由 Agent 使用 MCP preview 的 limit 分頁檢查其餘 Session。</p>
      </template>
      <div v-else class="metadata-backfill-empty metadata-backfill-empty-initial"><strong>尚未掃描</strong><p>按下掃描後，系統只會讀取中央 SQLite 中已保存的 Session metadata。</p></div>

      <div v-if="metadataBackfillRequest" class="metadata-backfill-agent-card">
        <div class="metadata-backfill-agent-heading">
          <div>
            <div class="eyebrow">AGENT REQUEST</div>
            <h4>請 Agent 回補 metadata</h4>
            <p v-if="metadataBackfillRequestIsActive">請在目前的 Codex 或 Claude 對話中輸入：「{{ metadataBackfillInstruction }}」Agent 會自行取得待回補清單、檢查 tracked 專案的 worktree／handoff，再只寫回已確認的 metadata。</p>
            <p v-else-if="metadataBackfillRequest.status === 'completed'">這批 metadata 已完成回補。重新掃描後，若仍有缺口會建立新的待處理請求。</p>
            <p v-else>這批 metadata 回補尚未完成，請重新整理狀態或再次請 Agent 處理。</p>
          </div>
          <span :class="['synthesis-status', `synthesis-status-${metadataBackfillRequest.status}`]">{{ metadataBackfillStatusLabels[metadataBackfillRequest.status] }}</span>
        </div>
        <div class="metadata-backfill-agent-actions">
          <button class="primary-button" type="button" :disabled="metadataBackfillRequestLoading" @click="emit('copyMetadataBackfillInstruction')">複製 Agent 指令</button>
          <button v-if="metadataBackfillRequestIsActive" class="text-button cancel-button" type="button" :disabled="metadataBackfillRequestLoading" @click="emit('cancelMetadataBackfillRequest')">{{ metadataBackfillRequestLoading ? '取消中…' : '取消回補' }}</button>
          <button class="icon-button report-icon-button" type="button" :disabled="metadataBackfillRequestLoading" aria-label="重新整理 metadata 回補狀態" title="重新整理 metadata 回補狀態" @click="emit('loadMetadataBackfillRequest')"><span aria-hidden="true">↻</span></button>
          <button v-if="!metadataBackfillRequestIsActive && metadataBackfillPreview?.items.length" class="text-button" type="button" :disabled="metadataBackfillRequestCreating" @click="emit('createMetadataBackfillRequest')">重新建立回補請求</button>
        </div>
      </div>
      <div v-else-if="metadataBackfillPreview?.items.length" class="metadata-backfill-agent-card metadata-backfill-agent-card-warning">
        <div class="metadata-backfill-agent-heading">
          <div>
            <div class="eyebrow">ACTION REQUIRED</div>
            <h4>這些缺口需要 Agent 確認</h4>
            <p>掃描結果不會自行猜測檔案或驗證狀態；建立請求後，Agent 才能在目前對話中檢查並回寫。</p>
          </div>
        </div>
        <div class="metadata-backfill-agent-actions">
          <button class="primary-button" type="button" :disabled="metadataBackfillRequestCreating" @click="emit('createMetadataBackfillRequest')">{{ metadataBackfillRequestCreating ? '建立中…' : '請 Agent 回補 metadata' }}</button>
        </div>
      </div>
      <div v-if="metadataBackfillRequestError" class="alert error-alert metadata-backfill-alert" role="alert">{{ metadataBackfillRequestError }}</div>
    </section>

    <section class="project-list">
      <div class="list-heading"><span>所有專案</span><span>記錄狀態</span></div>
      <article v-for="project in projects" :key="project.id" class="project-row">
        <div class="project-avatar">{{ project.name.slice(0, 1).toUpperCase() }}</div>
        <div class="project-info">
          <strong>{{ project.name }}</strong>
          <span>{{ project.rootPath }}</span>
        </div>
        <div class="project-status-copy">
          <span :class="['status-chip', `status-${project.status}`]"><span class="chip-dot"></span>{{ statusLabels[project.status] }}</span>
          <small>{{ statusDescriptions[project.status] }}</small>
          <button v-if="project.status === 'tracked'" class="text-button import-trigger" type="button" :disabled="handoffImportLoading && handoffImportProjectId === project.id" @click.stop="emit('previewHandoffs', project)">{{ handoffImportLoading && handoffImportProjectId === project.id ? '預覽中…' : '預覽 handoff' }}</button>
        </div>
        <select :value="project.status" :aria-label="`更新 ${project.name} 的專案記錄狀態`" @change="emit('updateProjectStatus', project, ($event.target as HTMLSelectElement).value as ProjectStatus)">
          <option value="unregistered">未註冊</option>
          <option value="tracked">記錄中</option>
          <option value="paused">已暫停</option>
          <option value="ignored">已忽略</option>
        </select>
      </article>
      <div v-if="projects.length === 0" class="empty-state large-empty"><div class="empty-icon">◈</div><strong>還沒有專案</strong><p>加入第一個 workspace，建立你的中央 project registry。</p></div>
    </section>
  </section>
</template>
