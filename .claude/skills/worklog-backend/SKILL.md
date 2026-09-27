---
name: worklog-backend
description: Conventions for the Work Intelligence backend — packages/storage (SQLite services, migrations, transactions, FTS search, performance), apps/server (REST routes, error codes, security), apps/mcp (tool definitions, annotations, Agent contracts), packages/schema (zod input validation), and the project-data rules every new table or column must follow (export/import, permanent deletion, search index). Use whenever writing or reviewing code under packages/ or apps/server or apps/mcp.
---

# Work Intelligence backend (pointer)

The canonical skill is shared between Codex and Claude and lives at `.agents/skills/worklog-backend/SKILL.md`. Read that file from the repository root before working and treat it as this skill's content.

Do not duplicate content here; edit the file under `.agents/skills/worklog-backend/` instead, and keep this `description` in sync with it.
