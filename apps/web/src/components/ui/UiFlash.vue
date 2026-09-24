<script setup lang="ts">
import { computed } from "vue";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-vue-next";

const props = withDefaults(
  defineProps<{
    tone?: "accent" | "success" | "attention" | "danger";
    title?: string;
    dismissible?: boolean;
  }>(),
  { tone: "accent" },
);

const emit = defineEmits<{ dismiss: [] }>();
const icon = computed(
  () => ({ accent: Info, success: CircleCheck, attention: TriangleAlert, danger: CircleAlert })[props.tone],
);
</script>

<template>
  <div :class="['ui-flash', `ui-flash--${tone}`]" :role="tone === 'danger' ? 'alert' : 'status'">
    <component :is="icon" :size="16" :stroke-width="1.75" class="ui-flash__icon" aria-hidden="true" />
    <div class="ui-flash__body">
      <strong v-if="title">{{ title }}</strong>
      <slot />
    </div>
    <div v-if="$slots.actions" class="ui-flash__actions"><slot name="actions" /></div>
    <button v-if="dismissible" type="button" class="ui-flash__close" aria-label="關閉提示" @click="emit('dismiss')">
      <X :size="16" :stroke-width="1.75" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
.ui-flash {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border: 1px solid;
  border-radius: var(--radius);
  color: var(--fg);
  font-size: var(--text-md);
}

.ui-flash--accent {
  border-color: var(--accent-border);
  background: var(--accent-soft);
}
.ui-flash--success {
  border-color: var(--success-border);
  background: var(--success-soft);
}
.ui-flash--attention {
  border-color: var(--attention-border);
  background: var(--attention-soft);
}
.ui-flash--danger {
  border-color: var(--danger-border);
  background: var(--danger-soft);
}

.ui-flash--accent .ui-flash__icon {
  color: var(--accent);
}
.ui-flash--success .ui-flash__icon {
  color: var(--success);
}
.ui-flash--attention .ui-flash__icon {
  color: var(--attention);
}
.ui-flash--danger .ui-flash__icon {
  color: var(--danger);
}

.ui-flash__icon {
  margin-top: 3px;
}

.ui-flash__body {
  display: grid;
  flex: 1;
  gap: 2px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.ui-flash__actions {
  display: flex;
  gap: var(--space-2);
}

.ui-flash__close {
  display: inline-flex;
  padding: 2px;
  border: 0;
  border-radius: var(--radius);
  background: none;
  color: var(--fg-muted);
}

.ui-flash__close:hover {
  color: var(--fg);
}
</style>
