import { defineStore } from "pinia";
import { ref } from "vue";
import type { VoidTargetType } from "@work-intelligence/core";

/** Sessions and Evidence keep a void audit; a diagram keeps its void time and reason on the row. */
export type VoidTarget = { type: VoidTargetType | "diagram"; id: string; sessionId: string; title: string };

/** The void dialog: the record being voided and the reason typed so far. */
export const useRecordVoidStore = defineStore("record-void", () => {
  const voidTarget = ref<VoidTarget | null>(null);
  const voidReason = ref("");
  const voidSaving = ref(false);
  const voidError = ref("");

  function $reset(): void {
    voidTarget.value = null;
    voidReason.value = "";
    voidSaving.value = false;
    voidError.value = "";
  }

  return { voidTarget, voidReason, voidSaving, voidError, $reset };
});
