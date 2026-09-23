<template>
  <div class="ui-group-label" role="presentation"><slot /></div>
</template>

<style scoped>
.ui-group-label {
  padding: 6px var(--space-4);
  border-top: 1px solid var(--border-muted);
  background: var(--bg-subtle);
  color: var(--fg-muted);
  font-size: var(--text-xs);
  font-weight: 600;
}

.ui-group-label:first-child {
  border-top: 0;
}
</style>
