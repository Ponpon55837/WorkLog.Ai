import { computed, ref } from "vue";
import type { SessionDetail } from "@work-intelligence/core";
import { errorMessage } from "../utils/format";
import { runKeyed, useApi } from "./useApi";
import { useToast } from "./useToast";

const selectedDetail = ref<SessionDetail | null>(null);
/** Ordered Session IDs of the list the panel was opened from; drives J/K navigation. */
const sequence = ref<string[]>([]);

const position = computed(() => {
  const id = selectedDetail.value?.session.id;
  const index = id ? sequence.value.indexOf(id) : -1;
  return { index, total: sequence.value.length };
});

async function openSessionDetail(
  sessionId: string | undefined,
  failureMessage = "無法載入 Session detail。",
): Promise<void> {
  if (!sessionId) {
    return;
  }
  await runKeyed(
    "session-detail",
    async (signal) => {
      selectedDetail.value = await useApi().client.getSessionDetail(sessionId, signal);
    },
    {
      onError: (error) => useToast().showToast(errorMessage(error, failureMessage), "danger"),
    },
  );
}

function closeSessionDetail(): void {
  selectedDetail.value = null;
}

function setSessionSequence(ids: readonly string[]): void {
  sequence.value = [...ids];
}

function openAdjacentSession(step: 1 | -1): void {
  const { index } = position.value;
  const nextId = index >= 0 ? sequence.value[index + step] : undefined;
  void openSessionDetail(nextId);
}

export function useSessionDetail() {
  return {
    selectedDetail,
    position,
    openSessionDetail,
    closeSessionDetail,
    setSessionSequence,
    openAdjacentSession,
  };
}
