<script setup lang="ts">
import { computed } from "vue";
import type { SystemAgentConnections } from "@work-intelligence/core";
import StatusLabel from "./StatusLabel.vue";
import UiBox from "../ui/UiBox.vue";
import UiBoxTitle from "../ui/UiBoxTitle.vue";
import UiButton from "../ui/UiButton.vue";
import UiCommandBlock from "../ui/UiCommandBlock.vue";
import UiCopyButton from "../ui/UiCopyButton.vue";
import { onboardingStepStatusVisual } from "../../utils/status";
import { t } from "../../i18n";

/** Inputs summarize project setup and read-only Agent diagnostics for the first-run steps. */
const props = defineProps<{
  hasProject: boolean;
  hasTrackedProject: boolean;
  hasSession: boolean;
  agentConnections: SystemAgentConnections | null;
  agentStatusLoading: boolean;
  agentStatusError: string;
}>();

const agentConnected = computed(() =>
  props.agentConnections
    ? props.agentConnections.codex.mcpRegistered === "registered" ||
      props.agentConnections.claudeCode.mcpRegistered === "registered"
    : null,
);
const agentStepState = computed(() => {
  if (agentConnected.value) return "complete";
  if (
    props.agentConnections?.codex.mcpRegistered === "missing" &&
    props.agentConnections.claudeCode.mcpRegistered === "missing"
  ) {
    return "pending";
  }
  if (props.agentStatusError) return "unknown";
  return props.agentStatusLoading ? "checking" : "unknown";
});
</script>

<template>
  <UiBox data-testid="first-run-checklist">
    <template #header><UiBoxTitle eyebrow="FIRST RUN" :title="t('開始使用工作紀錄')" /></template>
    <ol class="first-run-checklist__steps">
      <li data-testid="first-run-step-project">
        <div class="first-run-checklist__step-heading">
          <StatusLabel :status="onboardingStepStatusVisual(hasProject ? 'complete' : 'pending')" />
          <div>
            <h3>{{ t("加入專案") }}</h3>
            <p>{{ t("先將本機專案加入 registry。") }}</p>
          </div>
        </div>
        <UiButton v-if="!hasProject" size="sm" :to="{ name: 'projects' }">{{ t("加入專案") }}</UiButton>
      </li>
      <li data-testid="first-run-step-tracking">
        <div class="first-run-checklist__step-heading">
          <StatusLabel :status="onboardingStepStatusVisual(hasTrackedProject ? 'complete' : 'pending')" />
          <div>
            <h3>{{ t("設為記錄中") }}</h3>
            <p>{{ t("明確啟用專案記錄後，Agent 才能為它保存工作紀錄。") }}</p>
          </div>
        </div>
        <UiButton v-if="hasProject && !hasTrackedProject" size="sm" :to="{ name: 'projects' }">{{
          t("查看專案")
        }}</UiButton>
      </li>
      <li data-testid="first-run-step-agent">
        <div class="first-run-checklist__step-heading">
          <StatusLabel :status="onboardingStepStatusVisual(agentStepState)" />
          <div>
            <h3>{{ t("連接 Agent") }}</h3>
            <p>{{ t("在 Codex 或 Claude Code 註冊 Work Intelligence MCP。") }}</p>
          </div>
        </div>
        <div v-if="!agentConnected" class="first-run-checklist__actions">
          <UiButton size="sm" :to="{ name: 'system-status' }">{{ t("查看連線狀態") }}</UiButton>
          <UiCopyButton size="sm" :label="t('複製安裝命令')" text="pnpm setup:agents" />
        </div>
      </li>
      <li data-testid="first-run-step-session">
        <div class="first-run-checklist__step-heading">
          <StatusLabel :status="onboardingStepStatusVisual(hasSession ? 'complete' : 'pending')" />
          <div>
            <h3>{{ t("第一筆工作記錄") }}</h3>
            <p>{{ t("完成工作後，請 Agent 整理並保存 Session。") }}</p>
          </div>
        </div>
        <div v-if="!hasSession" class="first-run-checklist__actions first-run-checklist__session-actions">
          <UiCommandBlock
            :text="t('請整理這次完成的工作、變更檔案與驗證結果，並保存第一筆工作記錄。')"
            :success-message="t('已複製工作記錄指令。')"
          />
          <UiButton size="sm" :to="{ name: 'sessions' }">{{ t("查看工作歷程") }}</UiButton>
        </div>
      </li>
    </ol>
  </UiBox>
</template>

<style scoped>
.first-run-checklist__steps {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding: var(--space-4);
  list-style: none;
}

.first-run-checklist__steps > li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-3);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border-muted);
}

.first-run-checklist__steps > li:last-child {
  padding-bottom: 0;
  border-bottom: 0;
}

.first-run-checklist__step-heading {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  min-width: 0;
}

.first-run-checklist__step-heading h3 {
  margin: 0;
  color: var(--fg);
  font-size: var(--text-md);
  font-weight: 600;
}

.first-run-checklist__step-heading p {
  margin: var(--space-1) 0 0;
  color: var(--fg-muted);
  font-size: var(--text-sm);
}

.first-run-checklist__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}

.first-run-checklist__session-actions {
  grid-column: 1 / -1;
  justify-content: stretch;
}

.first-run-checklist__session-actions :deep(.ui-command-block) {
  flex: 1 1 280px;
}

@media (max-width: 639px) {
  .first-run-checklist__steps > li {
    grid-template-columns: minmax(0, 1fr);
  }

  .first-run-checklist__actions {
    justify-content: flex-start;
  }
}
</style>
