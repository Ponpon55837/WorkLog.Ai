import { readonly, ref } from "vue";

const apiOfflineState = ref(false);

export function updateApiConnection(isOnline: boolean): void {
  apiOfflineState.value = !isOnline;
}

export function useApiConnection(): { isApiOffline: Readonly<typeof apiOfflineState> } {
  return { isApiOffline: readonly(apiOfflineState) };
}
