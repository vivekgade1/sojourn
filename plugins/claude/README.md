# Sojourn Claude Code plugin

Two things ship in this plugin:

1. **Hooks** — forwards Claude Code session lifecycle events (`SessionStart` /
   `PostToolUse` / `Stop`) to the local Sojourn daemon (`POST /api/hooks/claude`)
   so ingestion is immediate instead of waiting on the filesystem watcher's
   debounce. The hook script always exits 0 within ~3s, daemon up or not —
   capture never blocks or breaks a session.
2. **The `sojourn` skill** (`skills/sojourn/SKILL.md`) — teaches Claude Code how
   to drive the `soj` CLI: list flags with evidence, mark decisions/checkpoints,
   and walk a user through a preflight-confirmed restore, with the product's
   honesty rules (advisory never presented as verified) baked in. The complete
   user guide it defers to is `docs/USAGE.md` at the repo root.

## In-repo checkout assumption

`hooks/hooks.json` invokes the hook script via a path **relative to this
plugin directory inside the repo**:

```
node "${CLAUDE_PLUGIN_ROOT}/../../packages/adapter-claude/dist/hooks/postToolUse.js"
```

That path only resolves when the plugin runs from a checkout of this
repository with `packages/adapter-claude` built (`npm run build`). Installing
this plugin standalone (e.g. from a plugin marketplace, where only the
`plugins/claude/` directory is copied) will NOT work — the hook script would
not exist at that relative path. Packaging a self-contained plugin for
marketplace installs is planned post-V1.
