export const DATABASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('unregistered', 'tracked', 'paused', 'ignored')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_ingested_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_session_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  work_summary_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status = 'finalized'),
  execution_status TEXT NOT NULL DEFAULT 'completed' CHECK (execution_status = 'completed'),
  completed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  commit_sha TEXT,
  git_branch TEXT,
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  changed_files_provenance_json TEXT NOT NULL DEFAULT '[]',
  changed_file_changes_json TEXT NOT NULL DEFAULT '[]',
  verification_json TEXT
);

CREATE TABLE IF NOT EXISTS work_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('planning', 'execution', 'verification', 'closing', 'note', 'finalized')),
  summary TEXT NOT NULL,
  details_json TEXT,
  occurred_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind = 'handoff'),
  source_path TEXT,
  content TEXT NOT NULL,
  captured_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  reference TEXT NOT NULL,
  summary TEXT,
  captured_at TEXT NOT NULL,
  UNIQUE(session_id, kind, reference)
);

CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('decision', 'pattern', 'gotcha', 'procedure', 'skill')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  references_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS knowledge_audit (
  id TEXT PRIMARY KEY,
  knowledge_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'archived', 'restored')),
  before_json TEXT,
  after_json TEXT NOT NULL,
  changed_fields_json TEXT NOT NULL DEFAULT '[]',
  occurred_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS report_synthesis_requests (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('all', 'project')),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  period TEXT NOT NULL CHECK (period IN ('day', 'week', 'month', 'quarter', 'year', 'custom')),
  range_from TEXT NOT NULL,
  range_to TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  requested_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  failure_reason TEXT,
  source_session_ids_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS report_summaries (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES report_synthesis_requests(id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK (period IN ('day', 'week', 'month', 'quarter', 'year', 'custom')),
  range_from TEXT NOT NULL,
  range_to TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  executive_summary TEXT NOT NULL,
  themes_json TEXT NOT NULL DEFAULT '[]',
  highlights_json TEXT NOT NULL DEFAULT '[]',
  verification_json TEXT NOT NULL DEFAULT '[]',
  comparison_json TEXT NOT NULL DEFAULT '[]',
  risks_json TEXT NOT NULL DEFAULT '[]',
  decisions_json TEXT NOT NULL DEFAULT '[]',
  next_steps_json TEXT NOT NULL DEFAULT '[]',
  source_session_ids_json TEXT NOT NULL DEFAULT '[]',
  generated_by_agent TEXT NOT NULL,
  generated_by_model TEXT,
  prompt_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1))
);

CREATE TABLE IF NOT EXISTS metadata_backfill_requests (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('all', 'project')),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  requested_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  failure_reason TEXT,
  source_session_ids_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS session_summary_updates (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('replace', 'append')),
  summary TEXT NOT NULL,
  previous_summary TEXT NOT NULL,
  resulting_summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_work_summary_updates (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('replace', 'patch')),
  work_summary_json TEXT NOT NULL,
  previous_work_summary_json TEXT NOT NULL DEFAULT '{}',
  resulting_work_summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_sessions_project_completed ON sessions(project_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_completed ON sessions(completed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_session_occurred ON work_events(session_id, occurred_at ASC);
-- Context decisions now come from workSummary.decisions; drop the old note/closing event index.
DROP INDEX IF EXISTS idx_events_decisions_occurred;
CREATE INDEX IF NOT EXISTS idx_snapshots_session ON raw_snapshots(session_id);
CREATE INDEX IF NOT EXISTS idx_evidence_session_captured ON evidence(session_id, captured_at ASC);
CREATE INDEX IF NOT EXISTS idx_knowledge_project_updated ON knowledge(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_session_updated ON knowledge(session_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_audit_knowledge_occurred ON knowledge_audit(knowledge_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_report_synthesis_requests_status ON report_synthesis_requests(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_synthesis_requests_scope ON report_synthesis_requests(project_id, period, range_from, range_to, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_summaries_request_created ON report_summaries(request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_summaries_current_scope ON report_summaries(is_current, project_id, period, range_from, range_to, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_metadata_backfill_requests_status ON metadata_backfill_requests(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_metadata_backfill_requests_scope ON metadata_backfill_requests(project_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_summary_updates_session ON session_summary_updates(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_work_summary_updates_session ON session_work_summary_updates(session_id, created_at DESC);
`;
