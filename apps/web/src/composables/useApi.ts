import { useApiRequest } from "./useApiRequest";

type ApiRequest = ReturnType<typeof useApiRequest>;

let shared: ApiRequest | undefined;

export function useApi(): ApiRequest {
  shared ??= useApiRequest(import.meta.env.VITE_API_URL ?? "");
  return shared;
}
