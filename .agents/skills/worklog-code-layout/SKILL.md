---
name: worklog-code-layout
description: Fixed placement order for code in every Work Intelligence file type — Vue <script setup> sections (imports, types, macros, stores/composables, state, computed, functions, watchers, lifecycle, defineExpose), Pinia setup stores, composables, backend TypeScript modules and classes, and tests — plus the declare-before-use rule. Use whenever writing, moving, or reviewing code in apps/ or packages/ so every file reads in the same order; enforced by pnpm lint.
---

# Work Intelligence code layout

Every file of the same kind puts the same things in the same place, so a reader (human or Agent) knows where to look without reading the whole file. These rules apply to new code and to any code you touch. `pnpm lint` enforces the parts that can be checked mechanically.

## 1. The two rules behind every layout

1. **Declare before use.** A `const`/`let` must be declared above every line that reads it, including lines inside callbacks. Using it earlier throws at runtime (temporal dead zone) — for example an `immediate: true` watcher that reads a `computed` declared below it. ESLint `@typescript-eslint/no-use-before-define` rejects this. `function` declarations are hoisted, so they may sit below the code that calls them; that is what lets functions live in their own section.
2. **Group by kind, in dependency order.** Things that others depend on come first: types before values, inputs (props, stores) before derived values, derived values before the functions that use them, and side-effect wiring (watchers, lifecycle) last, once everything they touch exists.

## 2. Vue `<script setup>` (checked by `scripts/sfc-layout.mjs`)

Order of top-level statements:

| # | Section | What goes here |
|---|---|---|
| 1 | imports | Order in `worklog-web-code-style` §3: `vue`/`vue-router` → third party → `@work-intelligence/*` types → components → composables → router → stores → utils |
| 2 | types | `type` / `interface` only — ESLint `vue/define-macros-order` allows nothing else above the macros |
| 3 | macros, then constants | `defineOptions` → `defineProps`/`withDefaults` → `defineEmits` → `defineModel` → `defineSlots`, then module constants and option lists that do not depend on props or state (`const tabs = ["list", "candidates"] as const`) |
| 4 | stores and composables | `useRoute()`, `useXxxStore()` and its `storeToRefs()` destructuring, then composables that only **return** values (`useToast()`, `useKnowledgeActions()`) |
| 5 | state | `ref`, `reactive`, template refs; then composables that **take this component's state** as an argument (`useFocusTrap(dialog, open, …)`, `useRouteQuery("q", query, …)`, `useListReload({ … })`), placed right after the state they use |
| 6 | computed | `computed(…)`, in dependency order (a computed read by another comes first) |
| 7 | functions | event handlers and helpers that use component state; pure helpers without state may live in `utils/` instead |
| 8 | watchers | `watch` / `watchEffect` |
| 9 | lifecycle | `onMounted`, `onBeforeUnmount`, … in the order Vue calls them |
| 10 | expose | `defineExpose({ … })` last |

Plain statements that fit none of these (a one-off constant derived from a store, a single call) stay directly under the statement they belong with.

```ts
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, toRef, watch } from "vue";
import { storeToRefs } from "pinia";
import { useRoute } from "vue-router";
import UiButton from "../components/ui/UiButton.vue";
import { useFocusTrap } from "../composables/useFocusTrap";
import { useKnowledgeStore } from "../stores/knowledge";

type Tab = "list" | "candidates";

const props = defineProps<{ open: boolean; projectRoot?: string }>();
const emit = defineEmits<{ close: [] }>();
const tabs: readonly Tab[] = ["list", "candidates"];

const route = useRoute();
const knowledgeStore = useKnowledgeStore();
const { knowledgeItems } = storeToRefs(knowledgeStore);

const dialog = ref<HTMLElement | null>(null);
useFocusTrap(dialog, toRef(props, "open"), { onEscape: close });

const tab = computed<Tab>(() => (tabs.includes(route.params.tab as Tab) ? (route.params.tab as Tab) : "list"));
const visibleCount = computed(() => knowledgeItems.value.length);

function close(): void {
  emit("close");
}

watch(() => props.projectRoot, (root) => void knowledgeStore.loadCandidates(root), { immediate: true });
onBeforeUnmount(() => knowledgeStore.setKnowledgeListActive(false));
</script>
```

Then `<template>`, then `<style scoped>` (worklog-web-code-style §3).

Checking and fixing:

```bash
node scripts/sfc-layout.mjs          # part of pnpm lint
node scripts/sfc-layout.mjs --fix <files>
```

`--fix` only reorders files that break the order, keeps each statement's leading comments with it, and never changes a file that is already in order. Run `pnpm lint` afterwards: if a reorder would read a `const` before its declaration, `no-use-before-define` fails and you place that statement by hand.

## 3. Pinia setup stores (`apps/web/src/stores/*.ts`)

Inside `defineStore("name", () => { … })`:

1. Other stores and `useQueryCache()`.
2. State: `ref`s for view state (filters, selection, enable flags).
3. Queries: `useQuery({ key, enabled, query })`, with keys from `query-keys.ts` that include every parameter the query reads.
4. Computed values derived from state and query data.
5. Mutations: `useMutation({ mutation, onSuccess })` with their invalidations.
6. Actions: plain functions (`load…`, `set…Active`, `open…`).
7. Watchers, if any.
8. `return { … }` in the same order: state, computed, then actions.

Module-level helpers used by the store (pure functions, message maps) go above `defineStore`.

## 4. Composables (`apps/web/src/composables/*.ts`)

1. Imports, types.
2. Module constants and pure helpers.
3. The exported `useXxx(options)` function: state → computed → functions → watchers → lifecycle cleanup (`onBeforeUnmount`) → `return`.

Composables do not keep module-level reactive state. Dialog and form state that several components share (an open editor, its form, saving and error flags) lives in a Pinia setup store with a `$reset()` that returns it to closed and empty (`stores/knowledge-editor.ts`, `record-void.ts`, `confirm.ts`, `toasts.ts`, …); the composable reads it with `storeToRefs(useXxxStore())` and keeps the workflow functions. State used by one component stays in that component. Allowed module-level exceptions: a lazily created singleton with no reactivity (`useApi`), a non-reactive batching buffer (`useRouteQuery`), and the API connection flag (`useApiConnection`), which the fetch transport updates from callbacks that may run without an active Pinia.

## 5. Backend TypeScript modules (`packages/*`, `apps/server`, `apps/mcp`)

Order within a file:

1. Imports: Node built-ins → third party → `@work-intelligence/*` → relative.
2. Exported types and interfaces, then internal types.
3. Constants (limits, SQL fragments, regexes, lookup maps).
4. Private helper functions (pure, file-local).
5. Exported functions.
6. Exported classes.
7. Entry point (`main()` and the `if (import.meta.url === …)` guard) last.

Inside a class:

1. Static members.
2. Fields (`private readonly …`).
3. `constructor`.
4. Public methods, grouped by feature in the order callers use them (read → write → delete).
5. Private methods, after the public methods that use them.

Keep one exported concept per module; when a file mixes two services, split it (see `worklog-backend` §1).

## 6. Tests (`tests/<package>/*.test.ts`)

1. Imports.
2. Fixtures and constants (fictional data only).
3. Helper functions (`setup()`, `createDeps()`, builders).
4. `afterEach` / `beforeEach` cleanup.
5. `describe` blocks, one per behavior; inside, `it` cases ordered from the main path to edge cases and failures.

## 7. When you touch a file

- Put new code in its section; do not append everything at the bottom.
- If the file you edit is out of order, reorder it in the same PR only when the change is small; otherwise note it and keep the diff focused.
- Comments explain *why* and move with the code they describe.
