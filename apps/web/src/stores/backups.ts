import { useMutation, useQuery, useQueryCache } from "@pinia/colada";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type {
  DatabaseBackup,
  DatabaseBackupDeleteResult,
  DatabaseBackupList,
  DatabaseBackupListData,
} from "@work-intelligence/core";
import { confirmAction } from "../composables/useConfirm";
import { useApi } from "../composables/useApi";
import { useToast } from "../composables/useToast";
import { errorMessage } from "../utils/format";
import { databaseBackupKindLabels } from "../utils/labels";
import { queryKeys } from "./query-keys";
import { t } from "../i18n";

/** Owns the database backup query, backup mutations, and whole-database export. */
export const useBackupsStore = defineStore("backups", () => {
  const queryCache = useQueryCache();
  const backupsActive = ref(false);
  const backupDeleting = ref<string | null>(null);
  const databaseExporting = ref(false);

  const backupsQuery = useQuery({
    key: queryKeys.projects.backups,
    enabled: backupsActive,
    query: ({ signal }): Promise<DatabaseBackupList> => useApi().client.listBackups(signal),
  });

  async function invalidateBackupQueries(): Promise<void> {
    await Promise.all([
      queryCache.invalidateQueries({ key: queryKeys.projects.backups, exact: true }),
      queryCache.invalidateQueries({ key: queryKeys.views.systemStatus, exact: true }),
    ]);
  }

  function setBackupQueryData(data: DatabaseBackupListData): void {
    queryCache.setQueryData(queryKeys.projects.backups, {
      outcome: "database_backups",
      ...data,
    } satisfies DatabaseBackupList);
  }

  const createBackupMutation = useMutation({
    mutation: () => useApi().client.createBackup(),
    onSuccess: (result) => {
      setBackupQueryData(result);
      void invalidateBackupQueries().catch(() => undefined);
    },
  });
  const deleteBackupMutation = useMutation({
    mutation: (fileName: string): Promise<DatabaseBackupDeleteResult> => useApi().client.deleteBackup(fileName),
    onSuccess: (result) => {
      if (result.outcome !== "backup_deleted") return;
      setBackupQueryData(result);
      void invalidateBackupQueries().catch(() => undefined);
    },
  });

  const backups = computed(() => backupsQuery.data.value?.backups ?? []);
  const backupKeep = computed(() => backupsQuery.data.value?.keep ?? 0);
  const automaticBackupKeep = computed(() => backupsQuery.data.value?.automaticKeep ?? 0);
  const backupsLoading = computed(() => backupsQuery.isLoading.value);
  const backupsLoaded = computed(() => backupsQuery.data.value !== undefined);
  const backupsError = computed(() =>
    backupsQuery.error.value ? errorMessage(backupsQuery.error.value, t("projects.couldNotLoadTheBackup")) : "",
  );
  const backupCreating = computed(() => createBackupMutation.isLoading.value);

  function setBackupsActive(active: boolean): void {
    if (active) {
      void queryCache.invalidateQueries({ key: queryKeys.projects.backups, exact: true }, false);
      backupsActive.value = true;
      return;
    }

    backupsActive.value = false;
    queryCache.cancelQueries({ key: queryKeys.projects.backups, exact: true });
  }

  async function loadBackups(): Promise<void> {
    try {
      await backupsQuery.refetch(true);
    } catch {
      // Query state exposes load errors to the view.
    }
  }

  async function createBackup(): Promise<void> {
    const { showToast } = useToast();
    try {
      await createBackupMutation.mutateAsync();
      showToast(t("projects.backedUpTheCurrentData"), "success");
    } catch (error) {
      showToast(errorMessage(error, t("projects.backupFailed")), "danger");
    }
  }

  /** Confirms and removes one backup file; the only listed copy receives a stronger warning. */
  async function deleteBackup(backup: DatabaseBackup): Promise<void> {
    const { showToast } = useToast();
    const isLastBackup = backups.value.length === 1;
    const confirmed = await confirmAction({
      title: t("projects.deleteBackupConfirm", { fileName: backup.fileName }),
      message: [
        t("projects.kind", { value: databaseBackupKindLabels[backup.kind] }),
        t("projects.thisPermanentlyDeletesTheBackup"),
        ...(isLastBackup ? [t("projects.thisIsTheOnlyBackup")] : []),
      ].join(" "),
      confirmLabel: t("projects.deleteBackupPermanently"),
      danger: true,
    });
    if (!confirmed) return;

    backupDeleting.value = backup.fileName;
    try {
      const result = await deleteBackupMutation.mutateAsync(backup.fileName);
      if (result.outcome !== "backup_deleted") {
        showToast(t("projects.backupNotFoundRefreshThe"), "danger");
        return;
      }
      showToast(t("projects.deletedBackup", { fileName: result.deleted.fileName }), "success");
    } catch (error) {
      showToast(errorMessage(error, t("projects.couldNotDeleteTheBackup")), "danger");
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
      showToast(t("projects.allDataExportedTheFile"), "success");
    } catch (error) {
      showToast(errorMessage(error, t("projects.exportFailed")), "danger");
    } finally {
      databaseExporting.value = false;
    }
  }

  return {
    backups,
    backupKeep,
    automaticBackupKeep,
    backupsLoading,
    backupsLoaded,
    backupsError,
    backupCreating,
    backupDeleting,
    databaseExporting,
    setBackupsActive,
    loadBackups,
    createBackup,
    deleteBackup,
    exportDatabase,
  };
});
