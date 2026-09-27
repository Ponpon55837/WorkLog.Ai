import { describe, expect, it } from "vitest";
import { fixLayout, layoutProblems } from "../../../scripts/sfc-layout.mjs";

const component = (script: string) =>
  `<script setup lang="ts">\n${script}\n</script>\n\n<template><div /></template>\n`;

describe("<script setup> layout check", () => {
  it("accepts the fixed section order", () => {
    const source = component(`import { computed, onMounted, ref, watch } from "vue";
import { useExampleStore } from "../stores/example";

type Mode = "a" | "b";

const props = defineProps<{ mode: Mode }>();
const emit = defineEmits<{ change: [] }>();

const store = useExampleStore();
const count = ref(0);
const doubled = computed(() => count.value * 2);

function increment(): void {
  count.value += 1;
  emit("change");
}

watch(() => props.mode, increment);
onMounted(() => store.load());
defineExpose({ increment, doubled });`);
    expect(layoutProblems(source)).toEqual([]);
  });

  it("reports lifecycle hooks and computed values placed out of order", () => {
    const source = component(`import { computed, onMounted, ref } from "vue";
const count = ref(0);
onMounted(() => undefined);
const doubled = computed(() => count.value * 2);`);
    expect(layoutProblems(source)).toEqual([
      "computed after lifecycle: const doubled = computed(() => count.value * 2);",
    ]);
  });

  it("keeps a composable that takes local state after that state, so the fix cannot break declare-before-use", () => {
    const source = component(`import { ref } from "vue";
import { useFocusTrap } from "../composables/useFocusTrap";
function close(): void {}
const dialog = ref<HTMLElement | null>(null);
useFocusTrap(dialog, { onEscape: close });
const open = ref(false);`);
    const fixed = fixLayout(source);
    expect(layoutProblems(fixed)).toEqual([]);
    const script = fixed.slice(fixed.indexOf("import"), fixed.indexOf("</script>"));
    expect(script.indexOf("const dialog")).toBeLessThan(script.indexOf("useFocusTrap(dialog"));
    expect(script.indexOf("useFocusTrap(dialog")).toBeLessThan(script.indexOf("function close"));
  });

  it("moves leading comments with their statement and leaves ordered files unchanged", () => {
    const ordered = component(`import { ref } from "vue";
// Why this state exists.
const value = ref(1);`);
    expect(fixLayout(ordered)).toBe(ordered);
    const misplaced = component(`import { onMounted, ref } from "vue";
onMounted(() => undefined);
// Why this state exists.
const value = ref(1);`);
    const fixed = fixLayout(misplaced);
    expect(fixed).toContain("// Why this state exists.\nconst value = ref(1);");
    expect(fixed.indexOf("const value")).toBeLessThan(fixed.indexOf("onMounted("));
  });
});
