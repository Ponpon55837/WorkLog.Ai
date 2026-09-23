import { ref } from "vue";

export type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type PendingConfirm = ConfirmOptions & { resolve: (confirmed: boolean) => void };

const pending = ref<PendingConfirm | null>(null);

/** Promise-based confirmation rendered by the single ConfirmHost in AppShell. */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  pending.value?.resolve(false);
  return new Promise((resolve) => {
    pending.value = { ...options, resolve };
  });
}

export function useConfirmState() {
  function settle(confirmed: boolean): void {
    const current = pending.value;
    pending.value = null;
    current?.resolve(confirmed);
  }
  return { pending, settle };
}
