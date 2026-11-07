/** The database rules live in @work-intelligence/shared so the server, CLI, doctor, and MCP resolve the same path. */
export {
  configDirectory,
  databasePathFor,
  linkedRepositoryRoot,
  STANDALONE,
  standaloneDatabasePath,
} from "@work-intelligence/shared/database-location";
