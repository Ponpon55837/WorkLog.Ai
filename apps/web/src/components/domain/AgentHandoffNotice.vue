<script setup lang="ts">
import { X } from "lucide-vue-next";
import UiButton from "../ui/UiButton.vue";
import UiCommandBlock from "../ui/UiCommandBlock.vue";
import StatusLabel from "./StatusLabel.vue";
import type { StatusVisual } from "../../utils/status";
import { t } from "../../i18n";

/** The handoff step of an Agent flow: where the request stands, what happens next, the sentence to say to the Agent, and a way to cancel. */
defineProps<{
  title?: string;
  status?: StatusVisual;
  message: string;
  command?: string;
  successMessage?: string;
  cancelLabel?: string;
  cancelLoading?: boolean;
  cancelDisabled?: boolean;
}>();
const emit = defineEmits<{ cancel: [] }>();
</script>

<template>
  <section class="agent-handoff" :aria-label="title ?? t('common.handoffTitle')">
    <header v-if="title || status" class="agent-handoff__head">
      <strong v-if="title">{{ title }}</strong>
      <StatusLabel v-if="status" :status="status" />
    </header>
    <p class="agent-handoff__message">{{ message }}</p>
    <slot />
    <div v-if="command" class="agent-handoff__command">
      <p class="agent-handoff__say">{{ t("common.handoffSayToAgent") }}</p>
      <UiCommandBlock :text="command" :success-message="successMessage" />
    </div>
    <div v-if="cancelLabel || $slots.actions" class="agent-handoff__actions">
      <slot name="actions" />
      <UiButton
        v-if="cancelLabel"
        variant="danger"
        size="sm"
        :icon="X"
        :loading="cancelLoading"
        :disabled="cancelDisabled"
        @click="emit('cancel')"
        >{{ cancelLabel }}</UiButton
      >
    </div>
  </section>
</template>

<style scoped>
.agent-handoff {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-subtle);
}

.agent-handoff__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
}

.agent-handoff__message,
.agent-handoff__say {
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--text-sm);
  line-height: 1.6;
}

.agent-handoff__command {
  display: grid;
  gap: var(--space-1);
}

.agent-handoff__actions:empty {
  display: none;
}

.agent-handoff__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
</style>
