import { createApiClient, type ApiClient } from "../api/client";
import { updateApiConnection } from "./useApiConnection";

/**
 * The API client plus request helpers. In-flight queries are cancelled through Pinia Colada
 * (`useQueryCache().cancelQueries()`), which owns every query's AbortSignal.
 */
export function useApiRequest(baseUrl = ""): {
  client: ApiClient;
  request: ApiClient["request"];
  isAbortError: (error: unknown) => boolean;
} {
  const client = createApiClient(baseUrl, updateApiConnection);

  function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
  }

  return { client, request: client.request.bind(client), isAbortError };
}
