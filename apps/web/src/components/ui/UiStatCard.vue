<script setup lang="ts">
import type { IconComponent, Tone } from "./types";

defineProps<{
  label: string;
  value: string | number;
  icon?: IconComponent;
  /** Secondary value after the main number, e.g. "/ 24 通過". */
  suffix?: string;
  foot?: string;
  valueTone?: Tone;
  delta?: { direction: "up" | "down" | "flat"; text: string };
}>();
</script>

<template>
  <article class="ui-stat">
    <div class="ui-stat__label">
      <component :is="icon" v-if="icon" :size="16" :stroke-width="1.75" aria-hidden="true" />
      {{ label }}
    </div>
    <div :class="['ui-stat__value', valueTone && `tone-${valueTone}`]">
      {{ value }}
      <span v-if="suffix" class="ui-stat__suffix">{{ suffix }}</span>
      <span v-if="delta" :class="['ui-stat__delta', `ui-stat__delta--${delta.direction}`]">
        {{ delta.direction === "up" ? "▲" : delta.direction === "down" ? "▼" : "—" }} {{ delta.text }}
      </span>
    </div>
    <slot />
    <div v-if="foot || $slots.foot" class="ui-stat__foot"><slot name="foot">{{ foot }}</slot></div>
  </article>
</template>

<style scoped>
.ui-stat {
  min-width: 0;
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-subtle);
}

.ui-stat__label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.ui-stat__value {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
  margin-top: var(--space-2);
  color: var(--fg);
  font-size: var(--text-2xl);
  font-weight: 600;
  line-height: 1.2;
}

.ui-stat__suffix {
  color: var(--fg-muted);
  font-size: var(--text-md);
  font-weight: 400;
}

.ui-stat__delta {
  font-size: var(--text-xs);
  font-weight: 500;
}

.ui-stat__delta--up { color: var(--success); }
.ui-stat__delta--down { color: var(--danger); }
.ui-stat__delta--flat { color: var(--fg-muted); }

.ui-stat__foot {
  margin-top: var(--space-1);
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.tone-attention { color: var(--attention); }
.tone-danger { color: var(--danger); }
.tone-success { color: var(--success); }
</style>
