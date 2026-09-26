import { ref } from "vue";
import type { DatabaseBackup, DatabaseBackupDeleteResult } from "@work-intelligence/core";
import { databaseBackupKindLabels } from "../utils/labels";
import { errorMessage } from "../utils/format";
import { confirmAction } from "./useConfirm";
import { runKeyed, useApi } from "./useApi";
import { useToast } from "./useToast";

const backups = ref<DatabaseBackup[]>([]);
const backupKeep = ref(0);
const automaticBackupKeep = ref(0);
const backupsLoading = ref(false);
const backupsError = ref("");
const backupCreating = ref(false);
const backupDeleting = ref<string | null>(null);
const databaseExporting = ref(false);

/** Backups the API server keeps beside the database, newest first. */
async function loadBackups(): Promise<void> {
  backupsLoading.value = true;
  await runKeyed(
    "backups",
    async (signal) => {
      const result = await useApi().client.listBackups(signal);
      backups.value = result.backups;
      backupKeep.value = result.keep;
      automaticBackupKeep.value = result.automaticKeep;
      backupsError.value = "";
    },
    {
      onError: (error) => {
        backupsError.value = errorMessage(error, "無法載入備份清單。");
      },
      onSettled: () => {
        backupsLoading.value = false;
      },
    },
  );
}

async function createBackup(): Promise<void> {
  const { showToast } = useToast();
  backupCreating.value = true;
  try {
    const result = await useApi().client.createBackup();
    backups.value = result.backups;
    backupKeep.value = result.keep;
    automaticBackupKeep.value = result.automaticKeep;
    showToast("已備份目前的資料。", "success");
  } catch (error) {
    showToast(errorMessage(error, "備份失敗。"), "danger");
  } finally {
    backupCreating.value = false;
  }
}

/** Confirms and removes one backup file; the only listed copy receives a stronger warning. */
async function deleteBackup(backup: DatabaseBackup): Promise<void> {
  const { showToast } = useToast();
  const isLastBackup = backups.value.length === 1;
  const confirmed = await confirmAction({
    title: `刪除備份「${backup.fileName}」？`,
    message: [
      `類型：${databaseBackupKindLabels[backup.kind]}。`,
      "這會永久刪除這份備份檔。",
      ...(isLastBackup ? ["這是目前唯一列出的備份；刪除後將沒有可供還原的備份。"] : []),
    ].join(" "),
    confirmLabel: "永久刪除備份",
    danger: true,
  });
  if (!confirmed) {
    return;
  }

  backupDeleting.value = backup.fileName;
  try {
    const result: DatabaseBackupDeleteResult = await useApi().client.deleteBackup(backup.fileName);
    if (result.outcome !== "backup_deleted") {
      showToast("找不到這份備份，請重新整理清單。", "danger");
      return;
    }
    backups.value = result.backups;
    backupKeep.value = result.keep;
    automaticBackupKeep.value = result.automaticKeep;
    showToast(`已刪除備份：${result.deleted.fileName}`, "success");
  } catch (error) {
    showToast(errorMessage(error, "刪除備份失敗。"), "danger");
  } finally {
    backupDeleting.value = null;
  }
}

/** Saves the whole database as one file for moving to another computer. */
async function exportDatabase(): Promise<void> {
  const { showToast } = useToast();
  databaseExporting.value = true;
  try {
    const { blob, fileName } = await useApi().client.exportDatabase();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    // Some browsers start the download asynchronously; revoking right away can cancel it.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    showToast("已匯出整份資料。檔案包含全部工作記錄，請妥善保管。", "success");
  } catch (error) {
    showToast(errorMessage(error, "匯出失敗。"), "danger");
  } finally {
    databaseExporting.value = false;
  }
}

export function useBackups() {
  return {
    backups,
    backupKeep,
    automaticBackupKeep,
    backupsLoading,
    backupsError,
    backupCreating,
    backupDeleting,
    databaseExporting,
    loadBackups,
    createBackup,
    deleteBackup,
    exportDatabase,
  };
}
