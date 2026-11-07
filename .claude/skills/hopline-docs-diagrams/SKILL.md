---
name: hopline-docs-diagrams
description: Keep Hopline's docs/ and diagrams/ (Mermaid .mmd) accurate after a change, and validate that every diagram renders and every doc link resolves. Use when updating documentation, adding a diagram, or after behaviour changes.
---

# Docs and diagrams

## Where things live

- `docs/README.md` is the index; every new doc gets a row there. `diagrams/README.md` lists every `.mmd`.
- Root `README.md` is the overview; keep detail in `docs/`.
- Security changes: `docs/security.md` + `docs/security/vapt-report.md`.

## Writing rules

- Describe what the code does now; verify claims against the code (numbers, defaults, file names).
- Each diagram starts with a `%% Hopline — <what it shows>` comment.
- Mermaid pitfalls: in sequence diagrams a `;` inside a note/message ends the statement (use commas); quote
  flowchart labels containing punctuation; `<br/>` for line breaks.

## Validate

1. Diagrams: build a page that renders every `.mmd` with Mermaid (CDN `mermaid@11.4.1`, `mermaid.render` per file),
   serve it on a local port (the browser pane can't open `file://`), and check `failed: []` for all files.
2. Links: for every `docs/**/*.md`, `diagrams/*.md` and `README.md`, resolve each relative `](path)` against the file's
   folder and confirm it exists (0 broken).
3. `npx prettier --write docs diagrams README.md`.

Use the `docs-keeper` agent for larger doc refreshes.
