import { storeToRefs } from "pinia";
import { useConfirmStore, type ConfirmOptions } from "../stores/confirm";

export type { ConfirmOptions } from "../stores/confirm";

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return useConfirmStore().ask(options);
}

export function useConfirmState() {
  const store = useConfirmStore();
  const { pending } = storeToRefs(store);
  return { pending, settle: store.settle };
}
