import { createApiClient, type ApiClient } from "../api/client";
import { updateApiConnection } from "./useApiConnection";

export function useApiRequest(baseUrl = ""): {
  client: ApiClient;
  request: ApiClient["request"];
  beginRequest: (key: string) => AbortController;
  isCurrentRequest: (key: string, controller: AbortController) => boolean;
  finishRequest: (key: string, controller: AbortController) => void;
  isAbortError: (error: unknown) => boolean;
  abortAll: () => void;
} {
  const client = createApiClient(baseUrl, updateApiConnection);
  const activeRequestControllers = new Map<string, AbortController>();

  function beginRequest(key: string): AbortController {
    activeRequestControllers.get(key)?.abort();
    const controller = new AbortController();
    activeRequestControllers.set(key, controller);
    return controller;
  }

  function isCurrentRequest(key: string, controller: AbortController): boolean {
    return activeRequestControllers.get(key) === controller;
  }

  function finishRequest(key: string, controller: AbortController): void {
    if (isCurrentRequest(key, controller)) {
      activeRequestControllers.delete(key);
    }
  }

  function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
  }

  function abortAll(): void {
    for (const controller of activeRequestControllers.values()) {
      controller.abort();
    }
    activeRequestControllers.clear();
  }

  return {
    client,
    request: client.request.bind(client),
    beginRequest,
    isCurrentRequest,
    finishRequest,
    isAbortError,
    abortAll,
  };
}
