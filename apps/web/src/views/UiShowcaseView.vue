<script setup lang="ts">
import { ref } from "vue";
import { CircleCheck, CircleDashed, CircleX, Download, FolderGit2, Inbox, ListChecks, Plus, RefreshCw, Search, ShieldCheck } from "lucide-vue-next";
import PageHeader from "../components/layout/PageHeader.vue";
import UiActionMenu from "../components/ui/UiActionMenu.vue";
import UiBox from "../components/ui/UiBox.vue";
import UiBoxRow from "../components/ui/UiBoxRow.vue";
import UiBoxTitle from "../components/ui/UiBoxTitle.vue";
import UiButton from "../components/ui/UiButton.vue";
import UiCommandBlock from "../components/ui/UiCommandBlock.vue";
import UiCounter from "../components/ui/UiCounter.vue";
import UiDateRangeMenu from "../components/ui/UiDateRangeMenu.vue";
import UiDialog from "../components/ui/UiDialog.vue";
import UiEmptyState from "../components/ui/UiEmptyState.vue";
import UiField from "../components/ui/UiField.vue";
import UiFlash from "../components/ui/UiFlash.vue";
import UiGroupLabel from "../components/ui/UiGroupLabel.vue";
import UiIconButton from "../components/ui/UiIconButton.vue";
import UiLabel from "../components/ui/UiLabel.vue";
import UiMeter from "../components/ui/UiMeter.vue";
import UiPagination from "../components/ui/UiPagination.vue";
import UiSegmentedControl from "../components/ui/UiSegmentedControl.vue";
import UiSelect from "../components/ui/UiSelect.vue";
import UiSidePanel from "../components/ui/UiSidePanel.vue";
import UiSkeleton from "../components/ui/UiSkeleton.vue";
import UiStatCard from "../components/ui/UiStatCard.vue";
import UiTextInput from "../components/ui/UiTextInput.vue";
import UiUnderlineNav from "../components/ui/UiUnderlineNav.vue";
import { confirmAction } from "../composables/useConfirm";
import { useToast } from "../composables/useToast";
import type { ListPageSize } from "../utils/labels";

/** Dev-only catalogue of every ui/ component state (route /__ui). Not linked from navigation. */
const { showToast } = useToast();
const text = ref("");
const select = ref("all");
const menu = ref("all");
const segment = ref("week");
const tab = ref("overview");
const range = ref({ from: "", to: "" });
const pageSize = ref<ListPageSize>(10);
const panelOpen = ref(false);
const dialogOpen = ref(false);
const pageInfo = { page: 2, pageSize: 10, total: 128, totalPages: 13, from: 11, to: 20, hasPrevious: true, hasNext: true, truncated: false };

async function tryConfirm(): Promise<void> {
  const confirmed = await confirmAction({ title: "移除這個歷史版本？", message: "此操作無法復原。", confirmLabel: "移除", danger: true });
  showToast(confirmed ? "已確認" : "已取消", confirmed ? "success" : "default");
}
</script>

<template>
  <PageHeader title="UI 元件展示" eyebrow="DESIGN SYSTEM" description="開發用：檢查每個 ui/ 元件在各狀態的樣式與鍵盤操作。">
    <template #actions>
      <UiButton :icon="Download">Default</UiButton>
      <UiButton variant="primary" :icon="Plus">Primary</UiButton>
    </template>
  </PageHeader>

  <div class="showcase">
    <UiBox padded>
      <template #header><UiBoxTitle eyebrow="Buttons" title="按鈕" /></template>
      <div class="showcase__row">
        <UiButton>Default</UiButton>
        <UiButton variant="primary">Primary</UiButton>
        <UiButton variant="invisible">Invisible</UiButton>
        <UiButton variant="danger">Danger</UiButton>
        <UiButton loading>Loading</UiButton>
        <UiButton disabled>Disabled</UiButton>
        <UiButton size="sm" :icon="RefreshCw">Small</UiButton>
        <UiIconButton :icon="Search" label="搜尋" />
        <UiIconButton :icon="RefreshCw" label="重新整理" variant="default" />
      </div>
    </UiBox>

    <UiBox padded>
      <template #header><UiBoxTitle eyebrow="Labels" title="Label 與 Counter" /></template>
      <div class="showcase__row">
        <UiLabel>Neutral</UiLabel>
        <UiLabel tone="accent">Accent</UiLabel>
        <UiLabel tone="success" :icon="CircleCheck">通過</UiLabel>
        <UiLabel tone="danger" :icon="CircleX">失敗</UiLabel>
        <UiLabel tone="attention" :icon="CircleDashed">未回報</UiLabel>
        <UiLabel tone="done">已完成</UiLabel>
        <UiCounter :count="128" />
        <UiCounter :count="3" tone="attention" />
      </div>
    </UiBox>

    <UiBox padded>
      <template #header><UiBoxTitle eyebrow="Inputs" title="輸入" /></template>
      <div class="showcase__grid">
        <UiField label="文字" hint="說明文字"><UiTextInput v-model="text" :icon="Search" placeholder="搜尋…" /></UiField>
        <UiField label="選單"><UiSelect v-model="select" :options="[{ value: 'all', label: '全部' }, { value: 'a', label: 'A' }]" label="示範選單" /></UiField>
        <UiField label="錯誤" error="必填欄位"><UiTextInput v-model="text" /></UiField>
      </div>
      <div class="showcase__row showcase__row--spaced">
        <UiSegmentedControl v-model="segment" label="區間" :options="[{ value: 'day', label: '日' }, { value: 'week', label: '週' }, { value: 'month', label: '月' }]" />
        <UiActionMenu v-model="menu" label="驗證" header="篩選 verification" default-value="all" :items="[{ value: 'all', label: '全部' }, { value: 'passed', label: '通過', icon: CircleCheck, tone: 'success' }, { value: 'failed', label: '失敗', icon: CircleX, tone: 'danger' }]" />
        <UiActionMenu label="匯出" variant="button" :icon="Download" :items="[{ value: 'md', label: 'Markdown' }, { value: 'json', label: 'JSON' }]" @select="showToast(`匯出 ${$event}`)" />
        <UiDateRangeMenu v-model="range" />
      </div>
    </UiBox>

    <UiUnderlineNav v-model="tab" label="示範分頁" id-prefix="showcase" :items="[{ value: 'overview', label: '總覽', icon: Inbox }, { value: 'list', label: '清單', icon: ListChecks, count: 24 }]" />

    <div class="showcase__stats">
      <UiStatCard label="記錄中專案" :icon="FolderGit2" :value="3" foot="explicit opt-in" />
      <UiStatCard label="完成 Sessions" :value="24" :delta="{ direction: 'up', text: '4' }" foot="不等同 Git commit" />
      <UiStatCard label="Verification" :icon="ShieldCheck" :value="21" suffix="/ 24 通過">
        <UiMeter label="驗證分布" :segments="[{ value: 21, tone: 'success', label: '通過' }, { value: 1, tone: 'danger', label: '失敗' }, { value: 1, tone: 'neutral', label: '未執行' }, { value: 1, tone: 'attention', label: '未回報' }]" />
      </UiStatCard>
      <UiStatCard label="待處理" :icon="Inbox" :value="3" value-tone="attention" />
    </div>

    <UiBox>
      <template #header>
        <UiBoxTitle title="128 Sessions" :icon="ListChecks" />
        <UiActionMenu v-model="menu" label="驗證" default-value="all" align="end" :items="[{ value: 'all', label: '全部' }, { value: 'passed', label: '通過' }]" />
      </template>
      <UiGroupLabel>今天</UiGroupLabel>
      <UiBoxRow clickable title="可點擊的列" meta="WorkLog.Ai · 12 分鐘前" @select="panelOpen = true">
        <template #leading><CircleCheck :size="16" class="c-success" /></template>
        <template #trailing><UiLabel tone="success">通過</UiLabel></template>
      </UiBoxRow>
      <UiBoxRow title="靜態列" meta="沒有點擊行為" />
      <template #footer><UiPagination v-model:page-size="pageSize" :page-info="pageInfo" size-label="示範每頁筆數" /></template>
    </UiBox>

    <UiBox><UiSkeleton /></UiBox>
    <UiBox><UiEmptyState :icon="Inbox" title="全部處理完畢" description="目前沒有需要處理的項目。"><template #action><UiButton>前往</UiButton></template></UiEmptyState></UiBox>

    <UiFlash tone="danger" title="無法載入">伺服器沒有回應。<template #actions><UiButton size="sm">重試</UiButton></template></UiFlash>
    <UiFlash tone="attention" dismissible>資料已截斷。</UiFlash>
    <UiCommandBlock text="請處理我剛在 Work Intelligence 建立的報告提煉請求。" />

    <div class="showcase__row showcase__row--spaced">
      <UiButton @click="panelOpen = true">開啟 SidePanel</UiButton>
      <UiButton @click="dialogOpen = true">開啟 Dialog</UiButton>
      <UiButton variant="danger" @click="tryConfirm">Confirm</UiButton>
      <UiButton @click="showToast('一般通知')">Toast</UiButton>
      <UiButton @click="showToast('失敗通知', 'danger')">Toast (danger)</UiButton>
    </div>
  </div>

  <UiSidePanel :open="panelOpen" label="示範面板" @close="panelOpen = false">
    <template #header><strong>SidePanel</strong></template>
    <p>Esc 關閉、Tab 不會離開面板。</p>
    <UiButton @click="panelOpen = false">關閉</UiButton>
  </UiSidePanel>
  <UiDialog :open="dialogOpen" title="示範對話框" description="表單或決策使用置中對話框。" @close="dialogOpen = false">
    <UiField label="名稱"><UiTextInput v-model="text" autofocus /></UiField>
    <template #footer>
      <UiButton @click="dialogOpen = false">取消</UiButton>
      <UiButton variant="primary" @click="dialogOpen = false">儲存</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.showcase {
  display: grid;
  gap: var(--space-4);
}

.showcase__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.showcase__row--spaced {
  margin-top: var(--space-4);
}

.showcase__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-4);
}

.showcase__stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--space-4);
}

.c-success {
  color: var(--success);
}
</style>
