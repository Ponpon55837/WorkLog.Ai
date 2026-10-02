<script setup lang="ts">
import { ref } from "vue";
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  Download,
  FolderGit2,
  Inbox,
  ListChecks,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-vue-next";
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
import { t } from "../i18n";

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
const pageInfo = {
  page: 2,
  pageSize: 10,
  total: 128,
  totalPages: 13,
  from: 11,
  to: 20,
  hasPrevious: true,
  hasNext: true,
  truncated: false,
};

async function tryConfirm(): Promise<void> {
  const confirmed = await confirmAction({
    title: t("common.removeThisVersion"),
    message: t("showcase.thisCannotBeUndone"),
    confirmLabel: t("common.remove"),
    danger: true,
  });
  showToast(confirmed ? t("common.confirmed") : t("common.cancelled"), confirmed ? "success" : "default");
}
</script>

<template>
  <PageHeader
    :title="t('common.uiComponentShowcase')"
    eyebrow="DESIGN SYSTEM"
    :description="t('showcase.forDevelopmentCheckEveryUi')"
  >
    <template #actions>
      <UiButton :icon="Download">Default</UiButton>
      <UiButton variant="primary" :icon="Plus">Primary</UiButton>
    </template>
  </PageHeader>

  <div class="showcase">
    <UiBox padded>
      <template #header><UiBoxTitle eyebrow="Buttons" :title="t('showcase.button')" /></template>
      <div class="showcase__row">
        <UiButton>Default</UiButton>
        <UiButton variant="primary">Primary</UiButton>
        <UiButton variant="invisible">Invisible</UiButton>
        <UiButton variant="danger">Danger</UiButton>
        <UiButton loading>Loading</UiButton>
        <UiButton disabled>Disabled</UiButton>
        <UiButton size="sm" :icon="RefreshCw">Small</UiButton>
        <UiIconButton :icon="Search" :label="t('showcase.search')" />
        <UiIconButton :icon="RefreshCw" :label="t('common.refresh')" variant="default" />
      </div>
    </UiBox>

    <UiBox padded>
      <template #header><UiBoxTitle eyebrow="Labels" :title="t('showcase.labelAndCounter')" /></template>
      <div class="showcase__row">
        <UiLabel>Neutral</UiLabel>
        <UiLabel tone="accent">Accent</UiLabel>
        <UiLabel tone="success" :icon="CircleCheck">{{ t("common.passed") }}</UiLabel>
        <UiLabel tone="danger" :icon="CircleX">{{ t("common.failed") }}</UiLabel>
        <UiLabel tone="attention" :icon="CircleDashed">{{ t("common.notReported") }}</UiLabel>
        <UiLabel tone="done">{{ t("common.completedStatus") }}</UiLabel>
        <UiCounter :count="128" />
        <UiCounter :count="3" tone="attention" />
      </div>
    </UiBox>

    <UiBox padded>
      <template #header><UiBoxTitle eyebrow="Inputs" :title="t('showcase.input')" /></template>
      <div class="showcase__grid">
        <UiField :label="t('showcase.textLabel')" :hint="t('showcase.description')"
          ><UiTextInput v-model="text" :icon="Search" :placeholder="t('showcase.searchPlaceholder')"
        /></UiField>
        <UiField :label="t('showcase.menu')"
          ><UiSelect
            v-model="select"
            :options="[
              { value: 'all', label: t('showcase.all') },
              { value: 'a', label: 'A' },
            ]"
            :label="t('showcase.demoMenu')"
        /></UiField>
        <UiField :label="t('showcase.error')" :error="t('showcase.required')"><UiTextInput v-model="text" /></UiField>
      </div>
      <div class="showcase__row showcase__row--spaced">
        <UiSegmentedControl
          v-model="segment"
          :label="t('showcase.period')"
          :options="[
            { value: 'day', label: t('common.day') },
            { value: 'week', label: t('common.week') },
            { value: 'month', label: t('common.month') },
          ]"
        />
        <UiActionMenu
          v-model="menu"
          :label="t('common.verification')"
          :header="t('showcase.filterVerification')"
          default-value="all"
          :items="[
            { value: 'all', label: t('showcase.all') },
            { value: 'passed', label: t('common.passed'), icon: CircleCheck, tone: 'success' },
            { value: 'failed', label: t('common.failed'), icon: CircleX, tone: 'danger' },
          ]"
        />
        <UiActionMenu
          :label="t('common.export')"
          variant="button"
          :icon="Download"
          :items="[
            { value: 'md', label: 'Markdown' },
            { value: 'json', label: 'JSON' },
          ]"
          @select="showToast(t('showcase.exportEvent', { $event }))"
        />
        <UiDateRangeMenu v-model="range" />
      </div>
    </UiBox>

    <UiUnderlineNav
      v-model="tab"
      :label="t('showcase.demoTabs')"
      id-prefix="showcase"
      :items="[
        { value: 'overview', label: t('common.overview'), icon: Inbox },
        { value: 'list', label: t('common.list'), icon: ListChecks, count: 24 },
      ]"
    />

    <div class="showcase__stats">
      <UiStatCard :label="t('common.trackedProjects')" :icon="FolderGit2" :value="3" foot="explicit opt-in" />
      <UiStatCard
        :label="t('common.completedSessions')"
        :value="24"
        :delta="{ direction: 'up', text: '4' }"
        :foot="t('common.notTheSameAsGit')"
      />
      <UiStatCard label="Verification" :icon="ShieldCheck" :value="21" :suffix="t('showcase.passedOf24')">
        <UiMeter
          :label="t('showcase.verificationBreakdown')"
          :segments="[
            { value: 21, tone: 'success', label: t('common.passed') },
            { value: 1, tone: 'danger', label: t('common.failed') },
            { value: 1, tone: 'neutral', label: t('common.notRun') },
            { value: 1, tone: 'attention', label: t('common.notReported') },
          ]"
        />
      </UiStatCard>
      <UiStatCard :label="t('common.pending')" :icon="Inbox" :value="3" value-tone="attention" />
    </div>

    <UiBox>
      <template #header>
        <UiBoxTitle title="128 Sessions" :icon="ListChecks" />
        <UiActionMenu
          v-model="menu"
          :label="t('common.verification')"
          default-value="all"
          align="end"
          :items="[
            { value: 'all', label: t('showcase.all') },
            { value: 'passed', label: t('common.passed') },
          ]"
        />
      </template>
      <UiGroupLabel>{{ t("common.today") }}</UiGroupLabel>
      <UiBoxRow
        clickable
        :title="t('showcase.clickableRow')"
        :meta="t('showcase.worklogAi12MinutesAgo')"
        @select="panelOpen = true"
      >
        <template #leading><CircleCheck :size="16" class="c-success" /></template>
        <template #trailing
          ><UiLabel tone="success">{{ t("common.passed") }}</UiLabel></template
        >
      </UiBoxRow>
      <UiBoxRow :title="t('showcase.staticRow')" :meta="t('showcase.noClickAction')" />
      <template #footer
        ><UiPagination v-model:page-size="pageSize" :page-info="pageInfo" :size-label="t('showcase.demoPageSize')"
      /></template>
    </UiBox>

    <UiBox><UiSkeleton /></UiBox>
    <UiBox
      ><UiEmptyState
        :icon="Inbox"
        :title="t('common.allCaughtUp')"
        :description="t('showcase.nothingNeedsAttentionRightNow')"
        ><template #action
          ><UiButton>{{ t("common.go") }}</UiButton></template
        ></UiEmptyState
      ></UiBox
    >

    <UiFlash tone="danger" :title="t('common.couldNotLoad')"
      >{{ t("showcase.theServerDidNotRespond")
      }}<template #actions
        ><UiButton size="sm">{{ t("common.retry") }}</UiButton></template
      ></UiFlash
    >
    <UiFlash tone="attention" dismissible>{{ t("showcase.dataTruncated") }}</UiFlash>
    <UiCommandBlock :text="t('common.pleaseProcessTheReportSynthesis')" />

    <div class="showcase__row showcase__row--spaced">
      <UiButton @click="panelOpen = true">{{ t("showcase.openSidepanel") }}</UiButton>
      <UiButton @click="dialogOpen = true">{{ t("showcase.openDialog") }}</UiButton>
      <UiButton variant="danger" @click="tryConfirm">Confirm</UiButton>
      <UiButton @click="showToast(t('showcase.infoToast'))">Toast</UiButton>
      <UiButton @click="showToast(t('showcase.errorToast'), 'danger')">Toast (danger)</UiButton>
    </div>
  </div>

  <UiSidePanel :open="panelOpen" :label="t('showcase.demoPanel')" @close="panelOpen = false">
    <template #header><strong>SidePanel</strong></template>
    <p>{{ t("showcase.escClosesTabStaysInside") }}</p>
    <UiButton @click="panelOpen = false">{{ t("common.close") }}</UiButton>
  </UiSidePanel>
  <UiDialog
    :open="dialogOpen"
    :title="t('showcase.demoDialog')"
    :description="t('showcase.formsAndDecisionsUseA')"
    @close="dialogOpen = false"
  >
    <UiField :label="t('showcase.name')"><UiTextInput v-model="text" autofocus /></UiField>
    <template #footer>
      <UiButton @click="dialogOpen = false">{{ t("common.cancel") }}</UiButton>
      <UiButton variant="primary" @click="dialogOpen = false">{{ t("common.save") }}</UiButton>
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
