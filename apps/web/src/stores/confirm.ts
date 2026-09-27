import { defineStore } from "pinia";
import { ref } from "vue";

export type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

export type PendingConfirm = ConfirmOptions & { resolve: (confirmed: boolean) => void };

/** The one pending confirmation shown by UiConfirmHost; a new question cancels the previous one. */
export const useConfirmStore = defineStore("confirm", () => {
  const pending = ref<PendingConfirm | null>(null);

  function ask(options: ConfirmOptions): Promise<boolean> {
    pending.value?.resolve(false);
    return new Promise((resolve) => {
      pending.value = { ...options, resolve };
    });
  }

  function settle(confirmed: boolean): void {
    const current = pending.value;
    pending.value = null;
    current?.resolve(confirmed);
  }

  /** Answers any open question with "no" so nothing waits forever. */
  function $reset(): void {
    settle(false);
  }

  return { pending, ask, settle, $reset };
});
