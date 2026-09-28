# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`docs/specs/`**: the spec for the feature you're working on.
- **ADRs**: this fork's architecture decisions live in the companion module's repo, `~/repositories/quest-tracker/docs/adr/`, not here. Read ADRs that touch the area you're about to work in. `0005-bridge-fork-server-side-only.md` governs every change to this fork: keep changes server-side and don't modify `packages/foundry-module`.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This is a single-context repo: `packages/foundry-module`, `packages/mcp-server` and `shared` share one vocabulary.

```
/
├── CONTEXT.md
├── docs/specs/
│   ├── CHAT_HANDLER_SPEC.md
│   └── REGION_CHAT_WALLS_SPEC.md
└── packages/
    ├── foundry-module/
    └── mcp-server/

~/repositories/quest-tracker/docs/adr/   ← ADRs for this fork
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0005 (bridge fork server-side only), but worth reopening because…_
