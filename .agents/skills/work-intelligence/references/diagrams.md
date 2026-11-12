# Session diagrams

Read this guide with the core [Work Intelligence skill](../SKILL.md) before you attach a diagram. The core says when to attach one: on your own, without being asked, when a picture explains the work better than text.

- Up to two validated architecture v1 diagrams per Session, in `diagrams` when finalizing. After finalizing, `work_attach_diagram` adds one to an existing Session; use a new idempotency key per diagram.
- New writes require explicit `kind: "architecture"` and `formatVersion: 1`; first read `work-intelligence://agent/architecture-diagram-v1` and serialize validated JSON as `source`. A write that omits these fields or sends Mermaid is rejected. Do not invent native sequence/state semantics: explain unsupported semantics in prose.
- Historical Mermaid is read/import-only, shown as escaped source with copy/download, and keeps export/import and void/restore; rebuilding never converts historical diagrams, and sequence/state diagrams are never converted automatically.
- Draw only what this work actually did, with names and relative source paths from the code; no plans or ideas. Keep it small (about 3–12 nodes), give it a short title, and never put secrets, tokens, or personal data in it. Source locations and author-defined paths describe the snapshot, not a runtime trace.

People reading the repository find every field, limit, idempotency rule, and the data lifecycle in `docs/architecture-diagram-format.md`.
