import { useApiRequest } from "./useApiRequest";

type ApiRequest = ReturnType<typeof useApiRequest>;

let shared: ApiRequest | undefined;

/** The app-wide API client and abort helpers, shared by every store. */
export function useApi(): ApiRequest {
  shared ??= useApiRequest(import.meta.env.VITE_API_URL ?? "");
  return shared;
}
