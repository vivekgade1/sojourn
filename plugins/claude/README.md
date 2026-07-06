# Sojourn Claude Code plugin

Forwards Claude Code session lifecycle events (`SessionStart` / `PostToolUse` /
`Stop`) to the local Sojourn daemon (`POST /api/hooks/claude`) so ingestion is
immediate instead of waiting on the filesystem watcher's debounce. The hook
script always exits 0 within ~3s, daemon up or not — capture never blocks or
breaks a session.

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
