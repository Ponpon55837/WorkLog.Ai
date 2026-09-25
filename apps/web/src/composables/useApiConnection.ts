import { readonly, ref } from "vue";

const apiOfflineState = ref(false);

/** Updates the shared API connection state without exposing transport details to views. */
export function updateApiConnection(isOnline: boolean): void {
  apiOfflineState.value = !isOnline;
}

/** Returns the app-wide API availability signal used by the global connection banner. */
export function useApiConnection(): { isApiOffline: Readonly<typeof apiOfflineState> } {
  return { isApiOffline: readonly(apiOfflineState) };
}
