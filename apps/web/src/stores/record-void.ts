import { defineStore } from "pinia";
import { ref } from "vue";
import type { VoidTargetType } from "@work-intelligence/core";

export type VoidTarget = { type: VoidTargetType | "diagram"; id: string; sessionId: string; title: string };

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
