import { ref } from "vue";
import type { DatabaseBackup } from "@work-intelligence/core";
import { errorMessage } from "../utils/format";
import { runKeyed, useApi } from "./useApi";
import { useToast } from "./useToast";

const backups = ref<DatabaseBackup[]>([]);
const backupKeep = ref(0);
const automaticBackupKeep = ref(0);
const backupsLoading = ref(false);
const backupsError = ref("");
const backupCreating = ref(false);
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
    databaseExporting,
    loadBackups,
    createBackup,
    exportDatabase,
  };
}
