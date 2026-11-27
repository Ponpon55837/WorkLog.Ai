import { preflightDatabase } from "../../apps/server/src/database-preflight.js";
import { startApi } from "../../apps/server/src/start-api.js";

const path = process.env.START_API_TEST_DB;
if (!path) throw new Error("START_API_TEST_DB is required");
const result = await preflightDatabase(path);
if (!result.identity) throw new Error(`preflight failed: ${result.status}`);
startApi({ database: { path, identity: result.identity } });
