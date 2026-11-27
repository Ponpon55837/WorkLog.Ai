import { posix, win32 } from "node:path";

export type BackupNameKind =
  "automatic" | "manual" | "migration" | "deletion" | "session_deletion" | "maintenance" | "import";

export interface ParsedBackupName {
  readonly kind: BackupNameKind;
  readonly createdAt: string;
  readonly sequence: number;
}

function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

export function backupPrefix(databasePath: string, platform: NodeJS.Platform = process.platform): string {
  const { basename, extname } = pathApi(platform);
  return `${basename(databasePath, extname(databasePath))}-`;
}

export function parseBackupName(value: string): ParsedBackupName | null {
  const standardName = /^(automatic|manual)-(.+)$/.exec(value);
  const migrationName = /^pre-migration-v(\d+)-(.+)$/.exec(value);
  const maintenanceName = /^pre-maintenance-(.+)$/.exec(value);
  const deletionName = /^pre-delete-(.+)$/.exec(value);
  const sessionDeletionName = /^pre-session-delete-(.+)$/.exec(value);
  const importName = /^pre-import-(.+)$/.exec(value);
  const migrationVersion = migrationName?.[1] ? Number(migrationName[1]) : undefined;
  if (migrationName && (!Number.isSafeInteger(migrationVersion) || (migrationVersion ?? 0) < 1)) {
    return null;
  }
  // A name with no kind prefix at all is the legacy form (stamp only), kept as a manual backup. Any other prefix that is
  // not listed above leaves `stamp` unparsable below, so an unknown kind is refused rather than treated as manual.
  const kind: BackupNameKind = standardName
    ? standardName[1] === "automatic"
      ? "automatic"
      : "manual"
    : migrationName
      ? "migration"
      : deletionName
        ? "deletion"
        : sessionDeletionName
          ? "session_deletion"
          : importName
            ? "import"
            : maintenanceName
              ? "maintenance"
              : "manual";
  const stamp =
    standardName?.[2] ??
    migrationName?.[2] ??
    maintenanceName?.[1] ??
    deletionName?.[1] ??
    sessionDeletionName?.[1] ??
    importName?.[1] ??
    value;
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-(\d+))?$/.exec(stamp ?? value);
  if (!match) {
    return null;
  }
  const createdAt = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  const date = new Date(createdAt);
  const sequence = Number(match[7] ?? 1);
  if (
    Number.isNaN(date.valueOf()) ||
    date.toISOString().replace(/\.000Z$/, "Z") !== createdAt ||
    !Number.isSafeInteger(sequence) ||
    (match[7] !== undefined && sequence < 2)
  ) {
    return null;
  }
  return { kind, createdAt, sequence };
}

export function isSafeDatabaseBackupFileName(databasePath: string, fileName: string): boolean {
  return parseDatabaseBackupFileName(databasePath, fileName) !== null;
}

export function parseDatabaseBackupFileName(
  databasePath: string,
  fileName: string,
  platform: NodeJS.Platform = process.platform,
): ParsedBackupName | null {
  const containsControlCharacter = Array.from(fileName).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f;
  });
  if (
    fileName.length > 255 ||
    fileName.includes("..") ||
    /[\\/%:*?"<>|]/.test(fileName) ||
    containsControlCharacter ||
    pathApi(platform).basename(fileName) !== fileName
  ) {
    return null;
  }
  const prefix = backupPrefix(databasePath, platform);
  if (!fileName.startsWith(prefix) || !fileName.endsWith(".sqlite")) {
    return null;
  }
  return parseBackupName(fileName.slice(prefix.length, -".sqlite".length));
}
