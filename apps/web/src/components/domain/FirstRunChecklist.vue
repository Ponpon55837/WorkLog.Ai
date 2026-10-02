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
    <template #header><UiBoxTitle eyebrow="FIRST RUN" :title="t('dashboard.getStartedWithWorkRecords')" /></template>
    <ol class="first-run-checklist__steps">
      <li data-testid="first-run-step-project">
        <div class="first-run-checklist__step-heading">
          <StatusLabel :status="onboardingStepStatusVisual(hasProject ? 'complete' : 'pending')" />
          <div>
            <h3>{{ t("common.addProject") }}</h3>
            <p>{{ t("dashboard.addALocalProjectTo") }}</p>
          </div>
        </div>
        <UiButton v-if="!hasProject" size="sm" :to="{ name: 'projects' }">{{ t("common.addProject") }}</UiButton>
      </li>
      <li data-testid="first-run-step-tracking">
        <div class="first-run-checklist__step-heading">
          <StatusLabel :status="onboardingStepStatusVisual(hasTrackedProject ? 'complete' : 'pending')" />
          <div>
            <h3>{{ t("dashboard.setToTracked") }}</h3>
            <p>{{ t("dashboard.theAgentCanSaveWork") }}</p>
          </div>
        </div>
        <UiButton v-if="hasProject && !hasTrackedProject" size="sm" :to="{ name: 'projects' }">{{
          t("dashboard.viewProject")
        }}</UiButton>
      </li>
      <li data-testid="first-run-step-agent">
        <div class="first-run-checklist__step-heading">
          <StatusLabel :status="onboardingStepStatusVisual(agentStepState)" />
          <div>
            <h3>{{ t("dashboard.connectAgent") }}</h3>
            <p>{{ t("dashboard.registerTheWorkIntelligenceMcp") }}</p>
          </div>
        </div>
        <div v-if="!agentConnected" class="first-run-checklist__actions">
          <UiButton size="sm" :to="{ name: 'system-status' }">{{ t("dashboard.viewConnectionStatus") }}</UiButton>
          <UiCopyButton size="sm" :label="t('dashboard.copyInstallCommand')" text="pnpm setup:agents" />
        </div>
      </li>
      <li data-testid="first-run-step-session">
        <div class="first-run-checklist__step-heading">
          <StatusLabel :status="onboardingStepStatusVisual(hasSession ? 'complete' : 'pending')" />
          <div>
            <h3>{{ t("dashboard.firstWorkRecord") }}</h3>
            <p>{{ t("dashboard.afterFinishingWorkAskThe") }}</p>
          </div>
        </div>
        <div v-if="!hasSession" class="first-run-checklist__actions first-run-checklist__session-actions">
          <UiCommandBlock
            :text="t('dashboard.pleaseSummarizeTheWorkJust')"
            :success-message="t('dashboard.workRecordInstructionCopied')"
          />
          <UiButton size="sm" :to="{ name: 'sessions' }">{{ t("dashboard.viewWorkHistory") }}</UiButton>
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
