import console from "node:console";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
const d = new DatabaseSync(process.argv[2], { readOnly: true });
const trig = new Set(d.prepare("SELECT tbl_name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_data_revision_%'").all().map((r) => r.tbl_name));
const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%fts%'").all().map((r) => r.name);
const audit = new Set(["schema_migrations","change_revisions","search_chunks","search_paths","search_dirty","related_work_paths","related_work_dirty","void_audit","knowledge_audit","agent_read_audit","agent_read_audit_records","session_deletion_audit","project_deletion_audit","project_data_import_audits","database_maintenance_runs","project_location_audit","outstanding_item_events"]);
console.log("project-data tables WITHOUT data_revision trigger (excluding known audit/derived/index tables):");
let any = false;
for (const t of tables) if (!trig.has(t) && !audit.has(t)) { console.log("  MISSING? " + t); any = true; }
if (!any) console.log("  (none)");
console.log("\ntables WITH data_revision trigger:\n  " + [...trig].sort().join("\n  "));
