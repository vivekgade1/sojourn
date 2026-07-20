# Sojourn Claude Code plugin

Two things ship in this plugin:

1. **Hooks** (`hooks/hooks.json`) — forwards Claude Code session lifecycle
   events (`SessionStart` / `PostToolUse` / `Stop`) to the local Sojourn
   daemon (`POST /api/hooks/claude`) so ingestion is immediate instead of
   waiting on the filesystem watcher's debounce. The hook script always
   exits 0 within ~3.5s, daemon up or not — capture never blocks or breaks a
   session.
2. **The `sojourn` skill** (`skills/sojourn/SKILL.md`) — teaches Claude Code
   how to drive the `soj` CLI: list flags with evidence, mark
   decisions/checkpoints, and walk a user through a preflight-confirmed
   restore, with the product's honesty rules (advisory never presented as
   verified) baked in. The complete user guide it defers to is
   `docs/USAGE.md` at the repo root.

## What actually runs

`hooks/hooks.json` invokes one file for all three events:

```
"${CLAUDE_PLUGIN_ROOT}/hooks/sojourn-hook.mjs"
```

That path is entirely **inside this plugin directory** — no repo-relative
escape back out into the rest of the checkout. `sojourn-hook.mjs` is a generated,
self-contained ESM script (Node shebang, zero runtime imports outside Node
builtins — esbuild-bundled from
`packages/adapter-claude/src/hooks/postToolUse.ts`). Because it doesn't
reach outside itself, this plugin works the same way regardless of how it
got onto disk — see the install modes below.

## Install mode 0: the marketplace (recommended)

Nothing to clone. In Claude Code:

```
/plugin marketplace add vivekgade1/sojourn
/plugin install sojourn@sojourn
```

The marketplace manifest lives at the repo root (`.claude-plugin/marketplace.json`)
and its one entry sources `./plugins/claude` — this directory. Claude Code caches
the plugin under `~/.claude/plugins/`, which is why every path in `hooks/hooks.json`
must go through `${CLAUDE_PLUGIN_ROOT}`: the plugin does not run from the location
it was installed from.

Note that installed users only see an update when the `version` in
`.claude-plugin/plugin.json` changes. Pushing commits without bumping it leaves
them on the cached copy, reporting "already at the latest version".

## Install mode 1: in-repo dev checkout

You have (or are working in) a full clone of the `sojourn` repo.

```bash
git clone https://github.com/vivekgade1/sojourn.git
cd sojourn
npm install
npm run build            # tsc for all packages + web + build:plugin (regenerates the hook bundle)
claude plugin install /path/to/sojourn/plugins/claude   # or add via /plugin in Claude Code
```

This is the mode you want while developing Sojourn itself: the plugin
directory lives inside your checkout, and `npm run build` (or the narrower
`npm run build:plugin`) keeps `hooks/sojourn-hook.mjs` in sync with
`packages/adapter-claude/src/hooks/postToolUse.ts` — see
[Regenerating the bundle](#regenerating-the-bundle) below.

You still need `soj start` (or `soj open`) running from the same checkout
for the daemon the hooks talk to — the plugin only forwards events, it
doesn't run the daemon.

## Install mode 2: copied plugin directory

You only have this `plugins/claude/` directory — e.g. copied out of a
release archive, downloaded from a marketplace entry, or `cp -r`'d
somewhere on its own, with no `packages/` or `node_modules/` alongside it.

```bash
cp -r plugins/claude ~/wherever/sojourn-claude-plugin
claude plugin install ~/wherever/sojourn-claude-plugin
```

This works out of the box with **no `npm install` and no build step in the
copied directory** — `hooks/sojourn-hook.mjs` is already a finished,
dependency-free artifact. What you can't do from a copied directory is
regenerate that bundle (there's no TypeScript source or `esbuild` devDep in
`plugins/claude/` itself); to pick up hook changes, re-copy an updated
`plugins/claude/` from a repo checkout that has rebuilt it.

Either way, a running Sojourn daemon (`soj start`) is what actually records
anything — the plugin just pings it.

## Regenerating the bundle

Whenever `packages/adapter-claude/src/hooks/postToolUse.ts` changes, the
committed `hooks/sojourn-hook.mjs` artifact goes stale and must be rebuilt
from a repo checkout:

```bash
npm run build:plugin     # bundles postToolUse.ts -> plugins/claude/hooks/sojourn-hook.mjs
npm run validate:plugin  # rebuilds fresh, then spawns the built hook against a stub daemon
                          # and checks hooks.json has no path escapes out of the plugin dir
```

`build:plugin` is also chained into the top-level `npm run build`, so a
normal full build always leaves the plugin bundle current. `validate:plugin`
is the fast, no-daemon-required check to run after any hook-source change
or before committing the regenerated bundle — it fails loudly (non-zero
exit) if the bundle would reference anything outside Node builtins (the
plugin must stay self-contained) or if `hooks.json` resolves outside the
plugin directory.

## Opt-in: flags printed to the terminal (`SOJOURN_HOOK_FLAGS=1`)

By default the hook is silent — it POSTs the event and exits, printing
nothing. Set `SOJOURN_HOOK_FLAGS=1` in the environment Claude Code itself
runs in (e.g. `export SOJOURN_HOOK_FLAGS=1` in your shell profile before
launching `claude`, or `SOJOURN_HOOK_FLAGS=1 claude`) to additionally have
the `Stop` hook print that turn's active **verified** flags straight to the
terminal:

```
Sojourn: edit_claim_mismatch — claimed src/x.ts:42 edited, snapshot shows no change
```

Details:

- Only fires on `Stop`, and only when the daemon responds within its own
  short timeout — a slow or unreachable daemon means no lines print, same
  silent-and-exit-0 behavior as when the flag is unset.
- Lines come from `GET /api/sessions/:id/turn-flags` (docs/API.md),
  already budgeted (a handful of lines max, digest-collapsed on overflow).
- Verified-only by contract, and the hook itself drops any line that
  mentions "advisory" as a second guard — this surface never lets an
  unverified guess read as confirmed.
- This is purely additive: it never changes the exit code (always 0) or
  blocks the session either way.

## Other environment variables the hook honors

- `SOJOURN_PORT` — daemon port, default `4177`. Set this if you run the
  daemon on a non-default port; both the fire-and-forget POST and the
  opt-in turn-flags GET use it.

## Verifying a packaged plugin

`npm run validate:plugin` is the single command that exercises everything
this README describes: it rebuilds the bundle, spawns it exactly the way
`hooks.json` does (no `node` prefix, relying on the shebang + executable
bit) against a stub HTTP server standing in for the daemon, and parses
`hooks.json` to confirm every command resolves to a path inside this
plugin directory. Run it after touching anything under `plugins/claude/`
or `packages/adapter-claude/src/hooks/`.
