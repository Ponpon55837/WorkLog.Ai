import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { databasePathFor } from "@work-intelligence/shared/database-location";
import { backupOptionsFromEnvironment, type WorkIntelligenceStoreOptions } from "@work-intelligence/storage";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const databasePath = databasePathFor(repositoryRoot);

export const storeOptions: WorkIntelligenceStoreOptions = { backup: backupOptionsFromEnvironment(databasePath) };
