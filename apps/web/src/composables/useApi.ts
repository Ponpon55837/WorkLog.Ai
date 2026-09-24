import { useApiRequest } from "./useApiRequest";

type ApiRequest = ReturnType<typeof useApiRequest>;

let shared: ApiRequest | undefined;

/** App-wide API client with keyed request cancellation, shared by every domain composable. */
export function useApi(): ApiRequest {
  shared ??= useApiRequest(import.meta.env.VITE_API_URL ?? "");
  return shared;
}

/**
 * Runs `task` as the only in-flight request for `key`, aborting any previous one.
 * Abort errors are swallowed; `onSettled` runs only if this call is still the current request.
 */
export async function runKeyed(
  key: string,
  task: (signal: AbortSignal) => Promise<void>,
  handlers: { onError?: (error: unknown) => void; onSettled?: () => void } = {},
): Promise<void> {
  const { beginRequest, isCurrentRequest, finishRequest, isAbortError } = useApi();
  const controller = beginRequest(key);
  try {
    await task(controller.signal);
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    if (handlers.onError) {
      handlers.onError(error);
    } else {
      throw error;
    }
  } finally {
    if (isCurrentRequest(key, controller)) {
      handlers.onSettled?.();
    }
    finishRequest(key, controller);
  }
}
