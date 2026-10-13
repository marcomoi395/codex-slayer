# Domain Docs

## Before exploring

Read:

- `GLOSSARY.md` at the repository root.
- `docs/adr/` for decisions affecting the target area.

If these files do not exist, proceed without creating them pre-emptively.

## Layout

This is a single-context repository:

- root `GLOSSARY.md` contains domain terms;
- `docs/adr/` contains repository-wide architecture decisions;
- source code remains under `src/`.

## Vocabulary

Use terms defined in `GLOSSARY.md`. If a required concept is absent, flag the terminology gap rather than silently inventing a conflicting term.

## ADR conflicts

Surface conflicts explicitly. Do not override an ADR silently.
