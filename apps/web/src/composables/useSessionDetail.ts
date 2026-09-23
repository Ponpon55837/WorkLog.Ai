import { ref } from "vue";
import type { SessionDetail } from "@work-intelligence/core";
import { errorMessage } from "../utils/format";
import { runKeyed, useApi } from "./useApi";
import { useToast } from "./useToast";

const selectedDetail = ref<SessionDetail | null>(null);

async function openSessionDetail(sessionId: string | undefined, failureMessage = "無法載入 Session detail。"): Promise<void> {
  if (!sessionId) {
    return;
  }
  await runKeyed(
    "session-detail",
    async (signal) => {
      selectedDetail.value = await useApi().client.getSessionDetail(sessionId, signal);
    },
    { onError: (error) => useToast().showToast(errorMessage(error, failureMessage)) }
  );
}

function closeSessionDetail(): void {
  selectedDetail.value = null;
}

export function useSessionDetail() {
  return { selectedDetail, openSessionDetail, closeSessionDetail };
}
