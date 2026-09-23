---
name: worklog-ui
description: Use for ANY change to the Work Intelligence web UI (apps/web) — pages, components, styles, layouts, lists, filters, dialogs/side panels, icons, copy, or the P0–P4 UI redesign migration. Load this BEFORE editing any .vue or .css file under apps/web.
---

# Work Intelligence UI (pointer)

The canonical skill is shared between Codex and Claude and lives at `.agents/skills/worklog-ui/`. Read these files from the repository root before working, and treat them as this skill's content:

1. `.agents/skills/worklog-ui/SKILL.md` — fixed decisions, workflow, non-negotiables, verification checklist
2. `.agents/skills/worklog-ui/references/tokens.md` — colors, status mapping, typography, spacing, breakpoints
3. `.agents/skills/worklog-ui/references/components.md` — component catalog and APIs
4. `.agents/skills/worklog-ui/references/patterns.md` — layout, lists, detail views, states, keyboard, copy, responsive
5. `.agents/skills/worklog-ui/references/domain-semantics.md` — Session / verification / report / policy rules the UI must respect
6. `.agents/skills/worklog-ui/references/migration.md` — P0–P4 steps and old → new mapping
7. `.agents/skills/worklog-ui/assets/preview.html` — approved visual reference

Do not duplicate content here; edit the files under `.agents/skills/worklog-ui/` instead, and keep this `description` in sync with it.
