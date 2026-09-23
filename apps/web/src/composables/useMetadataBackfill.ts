import { computed, ref } from "vue";
import type { MetadataBackfillItem, MetadataBackfillPreview, MetadataBackfillRequest } from "@work-intelligence/core";
import { errorMessage } from "../utils/format";
import { runKeyed, useApi } from "./useApi";
import { useSessionDetail } from "./useSessionDetail";
import { confirmAction } from "./useConfirm";
import { useToast } from "./useToast";

export const metadataBackfillInstruction = "請處理我剛在 Work Intelligence 掃描出的 metadata 缺口。";

const metadataBackfillPreview = ref<MetadataBackfillPreview | null>(null);
const metadataBackfillLoading = ref(false);
const metadataBackfillError = ref("");
const metadataBackfillRequest = ref<MetadataBackfillRequest | null>(null);
const metadataBackfillRequestLoading = ref(false);
const metadataBackfillRequestCreating = ref(false);
const metadataBackfillRequestError = ref("");

const metadataBackfillRequestIsActive = computed(() => {
  const status = metadataBackfillRequest.value?.status;
  return status === "pending" || status === "processing";
});

async function loadMetadataBackfillRequest(): Promise<void> {
  metadataBackfillRequestLoading.value = true;
  metadataBackfillRequestError.value = "";
  await runKeyed(
    "metadata-backfill-request",
    async (signal) => {
      const result = await useApi().client.listMetadataBackfillRequests(signal);
      if (result.outcome === "metadata_backfill_requests") {
        metadataBackfillRequest.value = result.requests[0] ?? null;
      } else {
        metadataBackfillRequest.value = null;
        metadataBackfillRequestError.value = result.reason;
      }
    },
    {
      onError: (error) => {
        metadataBackfillRequest.value = null;
        metadataBackfillRequestError.value = errorMessage(error, "無法載入 metadata 回補請求狀態。");
      },
      onSettled: () => {
        metadataBackfillRequestLoading.value = false;
      }
    }
  );
}

async function createMetadataBackfillRequest(): Promise<void> {
  const preview = metadataBackfillPreview.value;
  if (!preview?.items.length || metadataBackfillRequestCreating.value) {
    return;
  }
  metadataBackfillRequestCreating.value = true;
  metadataBackfillRequestError.value = "";
  try {
    const result = await useApi().client.createMetadataBackfillRequest(preview.project?.id);
    if (result.outcome === "metadata_backfill_request") {
      metadataBackfillRequest.value = result.request;
      useToast().showToast(result.duplicate
        ? "已有待處理的 metadata 回補請求；請在目前的 Agent 對話中處理。"
        : `已建立 metadata 回補請求；請在目前的 Agent 對話中說：「${metadataBackfillInstruction}」`);
    } else if (result.outcome === "metadata_backfill_not_needed") {
      metadataBackfillRequest.value = null;
      useToast().showToast(result.reason);
    } else {
      metadataBackfillRequestError.value = result.reason;
    }
  } catch (error) {
    metadataBackfillRequestError.value = errorMessage(error, "建立 metadata 回補請求失敗。");
  } finally {
    metadataBackfillRequestCreating.value = false;
  }
}

async function cancelMetadataBackfillRequest(): Promise<void> {
  const requestToCancel = metadataBackfillRequest.value;
  if (!requestToCancel || !metadataBackfillRequestIsActive.value || metadataBackfillRequestLoading.value) {
    return;
  }
  if (!(await confirmAction({ title: "取消這批 metadata 回補？", message: "既有 Session 資料不會被刪除。", confirmLabel: "取消回補", cancelLabel: "繼續等待", danger: true }))) {
    return;
  }
  metadataBackfillRequestLoading.value = true;
  metadataBackfillRequestError.value = "";
  try {
    const result = await useApi().client.cancelMetadataBackfillRequest(requestToCancel.id);
    if (result.outcome !== "metadata_backfill_request_cancelled") {
      metadataBackfillRequestError.value = "reason" in result ? result.reason : "這批 metadata 回補目前無法取消。";
      return;
    }
    metadataBackfillRequest.value = result.request;
    useToast().showToast("已取消這批 metadata 回補；既有 Session 資料仍然保留。");
  } catch (error) {
    metadataBackfillRequestError.value = errorMessage(error, "取消 metadata 回補失敗。");
  } finally {
    metadataBackfillRequestLoading.value = false;
  }
}

function copyMetadataBackfillInstruction(): Promise<void> {
  return useToast().copyWithToast(metadataBackfillInstruction, "已複製自然語言 metadata 回補指令。");
}

async function previewMetadataBackfill(): Promise<void> {
  metadataBackfillLoading.value = true;
  metadataBackfillError.value = "";
  metadataBackfillRequestError.value = "";
  await runKeyed(
    "metadata-backfill-preview",
    async (signal) => {
      const result = await useApi().client.previewMetadataBackfill(50, signal);
      if (result.outcome !== "backfill_preview") {
        metadataBackfillPreview.value = null;
        metadataBackfillError.value = result.reason;
        return;
      }
      metadataBackfillPreview.value = result;
      if (result.items.length > 0) {
        await createMetadataBackfillRequest();
      } else {
        await loadMetadataBackfillRequest();
      }
    },
    {
      onError: (error) => {
        metadataBackfillError.value = errorMessage(error, "無法掃描 metadata 缺口。");
      },
      onSettled: () => {
        metadataBackfillLoading.value = false;
      }
    }
  );
}

function openMetadataBackfillSession(item: MetadataBackfillItem): Promise<void> {
  return useSessionDetail().openSessionDetail(item.sessionId, "無法載入待回補的 Session。");
}

export function useMetadataBackfill() {
  return {
    metadataBackfillPreview,
    metadataBackfillLoading,
    metadataBackfillError,
    metadataBackfillRequest,
    metadataBackfillRequestIsActive,
    metadataBackfillRequestLoading,
    metadataBackfillRequestCreating,
    metadataBackfillRequestError,
    loadMetadataBackfillRequest,
    createMetadataBackfillRequest,
    cancelMetadataBackfillRequest,
    copyMetadataBackfillInstruction,
    previewMetadataBackfill,
    openMetadataBackfillSession
  };
}
