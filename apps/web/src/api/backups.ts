import type { DatabaseBackupCreated, DatabaseBackupDeleted, DatabaseBackupList } from "@work-intelligence/core";
import { type ApiTransport } from "./transport";
import { t } from "../i18n";

export interface BackupsApi {
  listBackups(signal?: AbortSignal): Promise<DatabaseBackupList>;
  createBackup(): Promise<DatabaseBackupCreated>;
  deleteBackup(fileName: string, signal?: AbortSignal): Promise<DatabaseBackupDeleted>;
  exportDatabase(): Promise<{ blob: Blob; fileName: string }>;
}

export function createBackupsApi(client: ApiTransport): BackupsApi {
  return {
    listBackups(signal?: AbortSignal): Promise<DatabaseBackupList> {
      return client.request<DatabaseBackupList>("/api/backups", { signal });
    },

    createBackup(): Promise<DatabaseBackupCreated> {
      return client.write<DatabaseBackupCreated>("/api/backups", "POST", {});
    },

    deleteBackup(fileName: string, signal?: AbortSignal): Promise<DatabaseBackupDeleted> {
      return client.write<DatabaseBackupDeleted>(`/api/backups/${encodeURIComponent(fileName)}`, "DELETE", {}, signal);
    },

    async exportDatabase(): Promise<{ blob: Blob; fileName: string }> {
      const blob = await client.download("/api/export", {}, t("api.couldNotExportDataCheck"));
      const fileName =
        "work-intelligence-export-" + new Date().toLocaleDateString("sv-SE").replace(/-/g, "") + ".sqlite";
      return { blob, fileName };
    },
  };
}
