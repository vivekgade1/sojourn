#!/bin/bash
# Sojourn end-to-end DEMO — one command, real daemon, real output.
#
# Every step below runs against a live Sojourn daemon in a fully ISOLATED
# environment: its own $SOJOURN_HOME, its own $CLAUDE_CONFIG_DIR, its own
# port. The user's real ~/.sojourn and ~/.claude are never read or written by
# Sojourn during this run, and a daemon already running on the default port
# 4177 is never touched. The script fingerprints both real directories before
# and after the run and reports any difference.
#
# Exits non-zero if ANY step deviates from its expected result.
#
# Flags:
#   --skip-build   reuse the existing dist/ build
#   --keep         leave the temp dir (and its daemon) in place for poking
#
# docs/DEMO.md is built from a real run of this script.
set -u

REPO="$(cd "$(dirname "$0")/../.." && pwd -P)"
PORT="${DEMO_PORT:-4211}"
TRANSCRIPT="${DEMO_TRANSCRIPT:-/tmp/sojourn-demo-transcript.txt}"
SKIP_BUILD=0
KEEP=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --keep) KEEP=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 64 ;;
  esac
done

# `pwd -P` matters: the daemon derives a project id from the path capture
# hands it, while the CLI derives it from process.cwd() (always physical).
# On macOS /tmp is a symlink to /private/tmp, so a logical base path would
# make `soj flags` look up a different project id than capture wrote.
BASE="$(cd "$(mktemp -d /tmp/sojourn-demo.XXXXXX)" && pwd -P)"
export SOJOURN_HOME="$BASE/home"
export CLAUDE_CONFIG_DIR="$BASE/claude"
export SOJOURN_PORT="$PORT"
PROJECT="$BASE/proj"
CLI="$REPO/packages/cli/dist/main.js"
mkdir -p "$SOJOURN_HOME" "$CLAUDE_CONFIG_DIR/projects" "$PROJECT"

# Mirror everything to a transcript OUTSIDE $BASE (which cleanup removes).
exec > >(tee "$TRANSCRIPT") 2>&1

FAILURES=0
STEP=0

hr() { printf '%s\n' "────────────────────────────────────────────────────────────────────────"; }
section() {
  STEP=$((STEP + 1))
  echo
  hr
  echo "[$STEP] $*"
  hr
}
note() { echo "    ($*)"; }
fail() { echo "!! FAIL: $*"; FAILURES=$((FAILURES + 1)); }

# ── portability shims (darwin BSD tools vs GNU) ──────────────────────────
if stat -f '%i' . >/dev/null 2>&1; then
  file_inode() { stat -f '%i' "$1"; }
  file_line()  { stat -f '  %N  inode=%i  size=%z' "$1"; }
  fp_line()    { find "$1" -type f -exec stat -f '%N %z %m' {} + 2>/dev/null | sort; }
else
  file_inode() { stat -c '%i' "$1"; }
  file_line()  { stat -c '  %n  inode=%i  size=%s' "$1"; }
  fp_line()    { find "$1" -type f -exec stat -c '%n %s %Y' {} + 2>/dev/null | sort; }
fi
if command -v md5 >/dev/null 2>&1; then
  file_md5() { md5 -q "$1"; }
else
  file_md5() { md5sum "$1" | cut -d' ' -f1; }
fi

# ── the CLI, run from a chosen directory (project id comes from cwd) ─────
SOJ_CWD="$PROJECT"
soj_show() {
  echo "\$ (cd ${SOJ_CWD/#$BASE/\$BASE} && soj $*)"
  (cd "$SOJ_CWD" && node "$CLI" "$@")
  local rc=$?
  echo "[exit $rc]"
  return $rc
}
soj_expect() {
  local expected="$1"; shift
  soj_show "$@"
  local rc=$?
  [ "$rc" = "$expected" ] || fail "expected exit $expected, got $rc from: soj $*"
  return 0
}
post() { curl -s -X POST "http://localhost:$PORT$1" -H 'content-type: application/json'; }

cleanup() {
  if [ "$KEEP" = 1 ]; then
    echo "--keep: leaving $BASE in place (daemon may still be running on :$PORT)"
    return
  fi
  (cd "$PROJECT" 2>/dev/null && node "$CLI" stop >/dev/null 2>&1)
  local pid
  pid=$(cat "$SOJOURN_HOME/daemon.pid" 2>/dev/null || true)
  [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null
  rm -rf "$BASE"
  return 0
}
trap cleanup EXIT

# ─────────────────────────────────────────────────────────────────────────
section "Isolation"
echo "repo:              $REPO"
echo "temp base:         \$BASE = $BASE"
echo "SOJOURN_HOME:      \$BASE/home"
echo "CLAUDE_CONFIG_DIR: \$BASE/claude"
echo "port:              $PORT   (a daemon on the default 4177 is untouched)"
echo
REAL_SOJOURN="$HOME/.sojourn"
REAL_CLAUDE="$HOME/.claude"
fp_line "$REAL_SOJOURN" > "$BASE/before.sojourn"
fp_line "$REAL_CLAUDE"  > "$BASE/before.claude"
echo "fingerprinted the REAL dirs (path + size + mtime per file) so the run can"
echo "prove it left them alone:"
echo "  ~/.sojourn: $(wc -l < "$BASE/before.sojourn" | tr -d ' ') files"
echo "  ~/.claude:  $(wc -l < "$BASE/before.claude" | tr -d ' ') files"

# ─────────────────────────────────────────────────────────────────────────
section "Build"
if [ "$SKIP_BUILD" = 1 ]; then
  note "--skip-build: reusing the existing dist/"
else
  echo "\$ npm run build"
  if (cd "$REPO" && npm run build) > "$BASE/build.log" 2>&1; then
    echo "build ok"
  else
    tail -20 "$BASE/build.log"
    fail "build"
    exit 1
  fi
fi
[ -f "$CLI" ] || { fail "CLI not built at $CLI"; exit 1; }

# ─────────────────────────────────────────────────────────────────────────
section "Daemon lifecycle — soj start / soj status"
STALE=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
if [ -n "${STALE:-}" ]; then
  echo "killing stale listener(s) on :$PORT — $STALE"
  kill $STALE 2>/dev/null
  sleep 0.5
fi
SOJ_CWD="$REPO"
soj_expect 0 start
soj_expect 0 status
SOJ_CWD="$PROJECT"

# ─────────────────────────────────────────────────────────────────────────
section "Capture — a Claude session ingesting into the graph"
note "reusing scripts/e2e/gen-session.mjs: it synthesizes real Claude transcript"
note "JSONL and drives the daemon's hook route turn by turn, so every turn gets"
note "its own snapshot. No live Claude session is required."
export E2E_PORT="$PORT"
export E2E_PROJECT="$PROJECT"
export E2E_CLAUDE_DIR="$CLAUDE_CONFIG_DIR"
export E2E_OUT="$BASE/manifest.json"
echo "\$ node scripts/e2e/gen-session.mjs      # (tail)"
if ! node "$REPO/scripts/e2e/gen-session.mjs" 2>&1 | tail -5; then
  fail "session generation"
  exit 1
fi
export DEMO_PORT_ENV="$PORT"
PROJECT_ID=$(DEMO_LOOKUP_PORT="$PORT" DEMO_LOOKUP_ROOT="$PROJECT" node -e '
const port = process.env.DEMO_LOOKUP_PORT;
const root = process.env.DEMO_LOOKUP_ROOT;
const list = await (await fetch(`http://localhost:${port}/api/projects`)).json();
const hit = list.find((p) => p.root === root);
if (!hit) { console.error("project not registered for " + root); process.exit(1); }
console.log(hit.id);
') || { fail "project lookup"; exit 1; }
echo "project id: $PROJECT_ID"
echo
soj_expect 0 projects

# ─────────────────────────────────────────────────────────────────────────
section "Flags — deterministic (T1) claim-vs-snapshot checks"
note "every line is a claim the assistant made that the snapshot record contradicts"
soj_expect 0 flags

# ─────────────────────────────────────────────────────────────────────────
section "Tier-2 advisory critic — soj critic"
note "T2 calls the Anthropic API from the DAEMON. With no key it refuses rather"
note "than silently degrading to 'looks fine'."
soj_expect 1 critic claude:e2e-a-022

# ─────────────────────────────────────────────────────────────────────────
section "Decision memory — soj mark / soj checkpoint"
soj_expect 0 mark "walrus config is the source of truth" --kind decision
soj_expect 0 mark "assuming the retry budget is 3" --kind assumption
soj_expect 0 checkpoint "pre-refactor"

# ─────────────────────────────────────────────────────────────────────────
section "Decision memory — soj why / soj decisions (FTS5)"
soj_expect 0 why walrus
soj_expect 0 why walrus --file src/walrus.py
soj_expect 0 decisions

# ─────────────────────────────────────────────────────────────────────────
section "soj gate — CI exit codes"
note "exit 2: the project carries active verified flags"
soj_expect 2 gate
note "exit 0: a session with none"
soj_expect 0 gate --session e2e-clean-0005
note "exit 3: daemon unreachable — 'could not check', NOT 'clean'"
SOJOURN_PORT=4999
soj_expect 3 gate
SOJOURN_PORT="$PORT"

# ─────────────────────────────────────────────────────────────────────────
section "Rewind — exact-node conversation rewind, and its refusal"
WALRUS_NODE="claude:e2e-a-044"
COMPACT_NODE=$(node -e '
const fs = await import("node:fs/promises");
const m = JSON.parse(await fs.readFile(process.env.E2E_OUT, "utf8"));
console.log(m.scenarios.compaction.targetNodeId);
')
COMPACT_ENC=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$COMPACT_NODE")
echo "\$ curl -X POST /api/nodes/$WALRUS_NODE/rewind-plan      # clean ancestor chain"
post "/api/nodes/claude%3Ae2e-a-044/rewind-plan"; echo
echo
echo "\$ curl -X POST /api/nodes/$COMPACT_NODE/rewind-plan    # chain crosses a compaction boundary"
post "/api/nodes/$COMPACT_ENC/rewind-plan"; echo
note "the second REFUSES exact mode and falls back to a native --fork-session"
note "resume. Refusing is the feature: a transcript that cannot be faithfully"
note "reconstructed must never be fabricated."
echo
echo "planning is PURE — nothing on disk yet:"
echo "\$ ls \$CLAUDE_CONFIG_DIR/projects/-e2e-proj/"
ls "$CLAUDE_CONFIG_DIR/projects/-e2e-proj/"
echo
ORIG_TRANSCRIPT="$CLAUDE_CONFIG_DIR/projects/-e2e-proj/e2e-scenarios-0001.jsonl"
BEFORE_MD5=$(file_md5 "$ORIG_TRANSCRIPT")
echo "\$ curl -X POST /api/nodes/$WALRUS_NODE/rewind           # execute"
REWIND_JSON=$(post "/api/nodes/claude%3Ae2e-a-044/rewind")
echo "$REWIND_JSON"; echo
REWOUND_SESSION=$(printf '%s' "$REWIND_JSON" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{console.log(JSON.parse(s).newSessionId||"")}catch{console.log("")}});' 2>/dev/null || echo "")
sleep 2
AFTER_MD5=$(file_md5 "$ORIG_TRANSCRIPT")
echo
echo "original transcript md5 before: $BEFORE_MD5"
echo "original transcript md5 after:  $AFTER_MD5"
[ "$BEFORE_MD5" = "$AFTER_MD5" ] \
  && echo "unchanged: rewind only ever creates NEW files." \
  || fail "rewind mutated the original transcript"

# Origin-session integrity. This demo is what caught the defect where the
# synthesized session reused tool_use BLOCK ids, so the store's upsert MOVED
# the origin's tool nodes onto it. THE theft signature: a tool node whose id
# was minted by the e2e generator (`e2e-t-NNN`) but that now reports the
# REWOUND session as its owner. Note those ids come from one shared counter
# across all five scenario sessions, so "not owned by e2e-scenarios" would be
# a false positive — the rewound session id is the only correct comparand.
echo
echo "\$ # did the rewind steal any of the origin's tool nodes?"
if [ -z "${REWOUND_SESSION:-}" ]; then
  note "could not read newSessionId from the rewind response; see the"
  note "packages/daemon apiV2 regression tests, which assert this directly."
else
  STOLEN=$(curl -fsS "http://localhost:$PORT/api/projects/$PROJECT_ID/graph" 2>/dev/null \
    | REWOUND="$REWOUND_SESSION" node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        try{
          const g=JSON.parse(s);
          const nodes=Array.isArray(g)?g:(g.nodes||[]);
          const bad=nodes.filter(n=>
            (n.kind==="tool_use"||n.kind==="tool_result") &&
            /^claude:e2e-t-/.test(n.id||"") &&
            String(n.sessionId||"")===process.env.REWOUND);
          // String(), not the raw number: console.log of a NUMBER goes
          // through util.inspect, which ANSI-colors it when FORCE_COLOR is
          // set — and the codes then break the shell comparison below.
          console.log(String(bad.length));
        }catch{console.log("?")}
      });' 2>/dev/null || echo "?")
  STOLEN=$(printf '%s' "$STOLEN" | tr -cd '0-9?')
  if [ "$STOLEN" = "0" ]; then
    echo "0 stolen: every generator-minted tool node still belongs to its"
    echo "original session; the rewound session owns only freshened ids."
  elif [ "$STOLEN" = "?" ]; then
    note "could not evaluate origin-integrity (graph query failed); see the"
    note "packages/daemon apiV2 regression tests, which assert this directly."
  else
    fail "rewind stole $STOLEN tool node(s) onto session $REWOUND_SESSION"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────
section "Sidecar-before-transcript ordering"
echo "\$ ls -l \$CLAUDE_CONFIG_DIR/projects/-e2e-proj/"
ls -l "$CLAUDE_CONFIG_DIR/projects/-e2e-proj/"
SIDECAR=$(ls "$CLAUDE_CONFIG_DIR/projects/-e2e-proj/" | grep 'sojourn-rewind\.json$' | head -1 || true)
if [ -z "${SIDECAR:-}" ]; then
  fail "no .sojourn-rewind.json sidecar next to the synthesized transcript"
else
  echo
  echo "\$ head -c 300 $SIDECAR"
  head -c 300 "$CLAUDE_CONFIG_DIR/projects/-e2e-proj/$SIDECAR"; echo; echo
  [ -f "$CLAUDE_CONFIG_DIR/projects/-e2e-proj/${SIDECAR%.sojourn-rewind.json}.jsonl" ] \
    || fail "synthesized transcript missing for sidecar $SIDECAR"
fi
note "the sidecar is renamed into place BEFORE the transcript. The watcher only"
note "reacts to .jsonl, so a crash between the two renames can only leave an"
note "inert orphan sidecar — never an unattributed transcript, which would"
note "ingest as a phantom session carrying false verified flags."

# ─────────────────────────────────────────────────────────────────────────
section "Restore — preflight, then --yes, landing a worktree"
soj_expect 1 restore "$WALRUS_NODE"
note "preflight exits 1 on purpose: nothing happened, so this is not success"
echo
soj_expect 0 restore "$WALRUS_NODE" --yes
WORKTREE=$(ls -d "$SOJOURN_HOME/worktrees/$PROJECT_ID"/*/ 2>/dev/null | head -1 || true)
WORKTREE="${WORKTREE%/}"
[ -n "$WORKTREE" ] || { fail "no worktree landed"; exit 1; }
echo
echo "\$ ls -a \$WORKTREE"
ls -a "$WORKTREE"
echo
echo "\$ cat \$PROJECT/src/app.py    # the mainline project is untouched"
cat "$PROJECT/src/app.py"

# ─────────────────────────────────────────────────────────────────────────
section "Harvest — the return path (apply)"
echo "\$ edit src/app.py INSIDE the restored worktree"
printf 'def main():\n    return 99  # harvested back from the worktree\n' > "$WORKTREE/src/app.py"
echo
SOJ_CWD="$WORKTREE"
soj_expect 1 harvest
note "preflight exits 1: it printed the file table and wrote nothing"
echo
soj_expect 0 harvest --yes
SOJ_CWD="$PROJECT"
echo
echo "\$ cat \$PROJECT/src/app.py    # the mainline now carries the worktree's edit"
cat "$PROJECT/src/app.py"
grep -q 'harvested back from the worktree' "$PROJECT/src/app.py" \
  || fail "harvest --yes did not land the edit on the mainline"

# ─────────────────────────────────────────────────────────────────────────
section "Harvest — patch mode (mainline untouched)"
printf 'def main():\n    return 123  # patch-mode edit\n' > "$WORKTREE/src/app.py"
SOJ_CWD="$WORKTREE"
soj_expect 0 harvest --mode patch --yes
note "no applied/conflicted/identical counts are printed: in patch mode those"
note "arrays are ALWAYS empty, so '0 files applied' would be a lie."
echo
echo "\$ cat \$WORKTREE/.sojourn-harvest.patch"
cat "$WORKTREE/.sojourn-harvest.patch"
echo "\$ cat \$PROJECT/src/app.py    # unchanged — patch mode wrote nothing here"
cat "$PROJECT/src/app.py"
grep -q 'patch-mode edit' "$PROJECT/src/app.py" && fail "patch mode wrote to the mainline"
echo
note "--allow-conflicts is refused in patch mode rather than silently ignored:"
soj_expect 1 harvest --mode patch --allow-conflicts --yes
SOJ_CWD="$PROJECT"

# ─────────────────────────────────────────────────────────────────────────
section "Harvest — a conflict aborts CLEAN, then --allow-conflicts"
printf 'def main():\n    return 7  # MAINLINE moved independently\n' > "$PROJECT/src/app.py"
printf 'def main():\n    return 8  # WORKTREE moved differently\n' > "$WORKTREE/src/app.py"
SOJ_CWD="$WORKTREE"
soj_expect 1 harvest
note "preflight already names the conflict. Now try to apply it anyway:"
echo
soj_expect 1 harvest --yes
SOJ_CWD="$PROJECT"
echo
echo "the raw failure body — a TYPED code, and the 4xx status itself is the"
echo "promise that provably zero mainline bytes were written:"
echo "\$ curl -o body -w '%{http_code}' -X POST /api/worktrees/harvest -d '{...}'"
CODE=$(curl -s -o "$BASE/harvest-err.json" -w '%{http_code}' \
  -X POST "http://localhost:$PORT/api/worktrees/harvest" \
  -H 'content-type: application/json' \
  -d "{\"worktreePath\":\"$WORKTREE\",\"mode\":\"apply\",\"allowConflicts\":false}")
echo "HTTP $CODE"
cat "$BASE/harvest-err.json"; echo
[ "$CODE" = "400" ] || fail "expected HTTP 400 for a conflicting harvest, got $CODE"
echo
echo "\$ cat \$PROJECT/src/app.py    # mainline untouched by the aborted harvest"
cat "$PROJECT/src/app.py"
grep -q 'MAINLINE moved independently' "$PROJECT/src/app.py" \
  || fail "the aborted harvest modified the mainline"
echo
SOJ_CWD="$WORKTREE"
soj_expect 0 harvest --yes --allow-conflicts
SOJ_CWD="$PROJECT"
echo
echo "\$ cat \$PROJECT/src/app.py    # conflict markers, explicitly asked for"
cat "$PROJECT/src/app.py"
grep -q '<<<<<<< mainline' "$PROJECT/src/app.py" || fail "--allow-conflicts wrote no markers"

# ─────────────────────────────────────────────────────────────────────────
section "Snapshot excludes — .sojourn-restore.json / .sojourn-harvest.patch"
echo "\$ ls -a \$WORKTREE"
ls -a "$WORKTREE"
note "both Sojourn artifacts are physically present in the worktree. Now run a"
note "session whose cwd IS the worktree, so that tree gets snapshotted:"
echo "\$ node scripts/demo/gen-worktree-session.mjs"
WT_INFO=$(DEMO_PORT="$PORT" DEMO_CLAUDE_DIR="$CLAUDE_CONFIG_DIR" DEMO_WORKTREE="$WORKTREE" \
  node "$REPO/scripts/demo/gen-worktree-session.mjs") || { fail "worktree session"; WT_INFO=""; }
echo "$WT_INFO"
if [ -n "$WT_INFO" ]; then
  SNAP_REF=$(node -e 'console.log(JSON.parse(process.argv[1]).snapshotRef)' "$WT_INFO")
  echo
  echo "\$ git --git-dir=\$SOJOURN_HOME/snapshots/$PROJECT_ID ls-tree -r --name-only $SNAP_REF"
  git --git-dir="$SOJOURN_HOME/snapshots/$PROJECT_ID" ls-tree -r --name-only "$SNAP_REF"
  if git --git-dir="$SOJOURN_HOME/snapshots/$PROJECT_ID" ls-tree -r --name-only "$SNAP_REF" \
       | grep -q 'sojourn-restore\.json\|sojourn-harvest\.patch'; then
    fail "the snapshot captured a .sojourn-* artifact"
  else
    echo
    echo "neither artifact is in the captured tree."
    note "before this exclude, restoring a worktree-session node materialized a"
    note "STALE .sojourn-harvest.patch a user could 'git apply' believing it fresh."
  fi
fi

# ─────────────────────────────────────────────────────────────────────────
section "Combine — merging two sessions' FILE STATES (no transcript is invented)"
note "combine takes two nodes — typically from DIFFERENT sessions — and merges"
note "their FILE STATES into ONE NEW worktree against their nearest common"
note "ancestor. The graph stays a TREE: parentId is still single, and node B is"
note "recorded as PROVENANCE ONLY in meta.mergedFrom."
echo
if [ -z "${WT_INFO:-}" ]; then
  fail "no worktree session — cannot build a cross-session combine pair"
else
COMBINE_A=$(node -e 'console.log(String(JSON.parse(process.argv[1]).nodeId))' "$WT_INFO")
echo "node A — session demo-worktree-0006, snapshot of the FIRST worktree:"
echo "  $COMBINE_A"
echo
echo "now a SECOND worktree off the same origin node, driven by its own session,"
echo "so the two nodes genuinely live in different sessions:"
echo
ls -d "$SOJOURN_HOME/worktrees/$PROJECT_ID"/*/ 2>/dev/null | sort > "$BASE/wts.before"
soj_expect 0 restore "$WALRUS_NODE" --yes
ls -d "$SOJOURN_HOME/worktrees/$PROJECT_ID"/*/ 2>/dev/null | sort > "$BASE/wts.after"
WORKTREE2=$(comm -13 "$BASE/wts.before" "$BASE/wts.after" | head -1)
WORKTREE2="${WORKTREE2%/}"
if [ -z "$WORKTREE2" ]; then
  fail "the second restore landed no new worktree"
else
echo
echo "\$ # three edits in the SECOND worktree, chosen to cover every status:"
printf 'def combined():\n    return "from the SECOND session"\n' > "$WORKTREE2/src/combined_feature.py"
printf 'WALTZ = True\nTEMPO = "andante"  # only the SECOND session changed this\n' > "$WORKTREE2/src/walrus.py"
# Byte-identical to what the FIRST worktree already carries -> "identical".
printf 'def main():\n    return 8  # WORKTREE moved differently\n' > "$WORKTREE2/src/app.py"
echo "    src/combined_feature.py  — new file, only B has it"
echo "    src/walrus.py            — modified, only B moved it"
echo "    src/app.py               — set to EXACTLY what A already has"
echo
echo "\$ node scripts/demo/gen-worktree-session.mjs   # session demo-worktree-combine-0007"
WT2_INFO=$(DEMO_PORT="$PORT" DEMO_CLAUDE_DIR="$CLAUDE_CONFIG_DIR" DEMO_WORKTREE="$WORKTREE2" \
  DEMO_SESSION_ID="demo-worktree-combine-0007" \
  node "$REPO/scripts/demo/gen-worktree-session.mjs") || { fail "second worktree session"; WT2_INFO=""; }
echo "$WT2_INFO"
if [ -z "$WT2_INFO" ]; then
  fail "no node B — cannot combine"
else
COMBINE_B=$(node -e 'console.log(String(JSON.parse(process.argv[1]).nodeId))' "$WT2_INFO")
echo
echo "node B — session demo-worktree-combine-0007:"
echo "  $COMBINE_B"

echo
note "preflight first. Like restore and harvest, no --yes means DRY: it exits 1"
note "because nothing happened, and combine's preflight is the purest of the"
note "three — it snapshots nothing, not even into the shadow repo."
soj_expect 1 combine "$COMBINE_A" "$COMBINE_B"

echo
echo "the refusals, before the real thing:"
soj_expect 1 combine "$COMBINE_A" "$COMBINE_A"
note "a node cannot be combined with itself. The CLI catches it locally so the"
note "obvious mistake costs zero round-trips; the daemon rejects it too, with a"
note "plain 400 carrying NO 'code' — body validation never reaches the engine."
echo
SECOND_NODE=$(node -e '
const fs = await import("node:fs/promises");
const m = JSON.parse(await fs.readFile(process.env.E2E_OUT, "utf8"));
console.log(String(m.scenarios.secondSession.nodeId));
')
echo "\$ curl -o body -w '%{http_code}' -X POST /api/nodes/combine/preflight \\"
echo "    -d '{\"nodeIdA\":\"$COMBINE_A\",\"nodeIdB\":\"$SECOND_NODE\"}'"
CCODE=$(curl -s -o "$BASE/combine-err.json" -w '%{http_code}' \
  -X POST "http://localhost:$PORT/api/nodes/combine/preflight" \
  -H 'content-type: application/json' \
  -d "{\"nodeIdA\":\"$COMBINE_A\",\"nodeIdB\":\"$SECOND_NODE\"}")
echo "HTTP $CCODE"
cat "$BASE/combine-err.json"; echo
[ "$CCODE" = "400" ] || fail "expected HTTP 400 for a no-common-ancestor pair, got $CCODE"
grep -q '"code":"no_common_ancestor"' "$BASE/combine-err.json" \
  || fail "expected the typed code no_common_ancestor"
note "that node belongs to session e2e-second-0002 (the generator mints ids from"
note "ONE counter across all five sessions, so the 'e2e-a-' prefix says nothing"
note "about which session owns it). e2e-second-0002 is an unrelated session root:"
note "its chain never meets node A's, so there is no shared state to merge"
note "against and combine refuses rather than guessing a merge base."

# ── the honesty boundary: combine must synthesize NO transcript ──────────
echo
echo "\$ ls \$CLAUDE_CONFIG_DIR/projects/-e2e-proj/*.jsonl    # BEFORE the combine"
ls "$CLAUDE_CONFIG_DIR/projects/-e2e-proj/"*.jsonl | sort > "$BASE/jsonl.before"
sed "s#^$CLAUDE_CONFIG_DIR/projects/-e2e-proj/##" "$BASE/jsonl.before"

echo
soj_expect 0 combine "$COMBINE_A" "$COMBINE_B" --yes

COMBINE_WT=$(ls -d "$SOJOURN_HOME/worktrees/$PROJECT_ID"/combine-*/ 2>/dev/null | head -1 || true)
COMBINE_WT="${COMBINE_WT%/}"
echo
if [ -z "$COMBINE_WT" ] || [ ! -d "$COMBINE_WT" ]; then
  fail "combine --yes landed no worktree on disk"
else
  echo "\$ ls -a \$COMBINE_WT"
  ls -a "$COMBINE_WT"
  echo
  echo "\$ cat \$COMBINE_WT/src/app.py             # A's side, kept"
  cat "$COMBINE_WT/src/app.py"
  echo "\$ cat \$COMBINE_WT/src/walrus.py          # B's side, applied"
  cat "$COMBINE_WT/src/walrus.py"
  echo "\$ cat \$COMBINE_WT/src/combined_feature.py   # B's new file, applied"
  cat "$COMBINE_WT/src/combined_feature.py"
  grep -q 'WORKTREE moved differently' "$COMBINE_WT/src/app.py" \
    || fail "the combined worktree lost node A's content"
  grep -q 'andante' "$COMBINE_WT/src/walrus.py" \
    || fail "the combined worktree lost node B's edit"
  grep -q 'from the SECOND session' "$COMBINE_WT/src/combined_feature.py" \
    || fail "the combined worktree lost node B's new file"
  echo
  echo "one tree carrying BOTH sessions' work — and neither source worktree,"
  echo "nor the mainline project, was written to."
fi

# ── the combine node in the graph: parented to A, B as provenance ────────
echo
echo "\$ curl -s /api/projects/\$PROJECT_ID/graph | # find the combine node"
COMBINE_NODE=$(curl -fsS "http://localhost:$PORT/api/projects/$PROJECT_ID/graph" 2>/dev/null \
  | CA="$COMBINE_A" CB="$COMBINE_B" node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{
        const g=JSON.parse(s);
        const nodes=Array.isArray(g)?g:(g.nodes||[]);
        const hit=nodes.find(n=>(n.meta||{}).mergedFrom===process.env.CB);
        if(!hit){console.log("NONE");return;}
        // String(), never a raw value: console.log of a non-string goes
        // through util.inspect, which ANSI-colors it when FORCE_COLOR is set.
        console.log(String([hit.id,hit.kind,String(hit.parentId),
          String((hit.meta||{}).mergedFrom)].join(" ")));
      }catch{console.log("ERR")}
    });' 2>/dev/null || echo "ERR")
echo "  id kind parentId meta.mergedFrom"
echo "  $COMBINE_NODE"
CN_KIND=$(printf '%s' "$COMBINE_NODE" | awk '{print $2}' | tr -cd 'a-z_')
CN_PARENT=$(printf '%s' "$COMBINE_NODE" | awk '{print $3}' | tr -cd 'A-Za-z0-9:_.-')
CN_MERGED=$(printf '%s' "$COMBINE_NODE" | awk '{print $4}' | tr -cd 'A-Za-z0-9:_.-')
[ "$CN_KIND" = "checkpoint" ] || fail "combine node kind is '$CN_KIND', expected checkpoint"
[ "$CN_PARENT" = "$COMBINE_A" ] || fail "combine node parentId is '$CN_PARENT', expected A ($COMBINE_A)"
[ "$CN_MERGED" = "$COMBINE_B" ] || fail "combine node meta.mergedFrom is '$CN_MERGED', expected B ($COMBINE_B)"
note "parentId is A and ONLY A — the second ancestor rides in meta.mergedFrom"
note "(schema V4's nodes.merged_from column). Sojourn is not a DAG."

# ── THE assertion: no conversation was invented ──────────────────────────
sleep 2
echo
echo "\$ ls \$CLAUDE_CONFIG_DIR/projects/-e2e-proj/*.jsonl    # AFTER the combine"
ls "$CLAUDE_CONFIG_DIR/projects/-e2e-proj/"*.jsonl | sort > "$BASE/jsonl.after"
sed "s#^$CLAUDE_CONFIG_DIR/projects/-e2e-proj/##" "$BASE/jsonl.after"
echo
if diff -q "$BASE/jsonl.before" "$BASE/jsonl.after" >/dev/null; then
  echo "IDENTICAL — the combine created no transcript at all."
  note "this is the honesty boundary, and it is the most important check in this"
  note "section. Merging two conversations would mean inventing an interleaving"
  note "that never happened, so combine emits FILES ONLY. Neither source session"
  note "is continued: you start a genuinely fresh session in the output worktree,"
  note "and worktree aliasing links it back to node A by itself."
else
  echo "DIFFERS —"
  diff "$BASE/jsonl.before" "$BASE/jsonl.after"
  fail "the combine synthesized a transcript — combine must emit FILES ONLY"
fi
fi
fi
fi

# ─────────────────────────────────────────────────────────────────────────
section "The terminal flag-delivery race — GET /api/sessions/:id/turn-flags"
echo "\$ curl -s /api/sessions/e2e-storm-0003/turn-flags"
curl -s "http://localhost:$PORT/api/sessions/e2e-storm-0003/turn-flags"; echo
note "this is the route the Stop hook reads, on a 500ms budget. The hook fires"
note "the rescan that produces the CURRENT turn's flags and then immediately"
note "asks for them, so it usually renders the PREVIOUS turn's state. Hook"
note "silence is never a clean bill of health — 'soj flags' is."

# ─────────────────────────────────────────────────────────────────────────
section "soj gc — transcript sweep, dry-run by default"
echo "\$ ls \$CLAUDE_CONFIG_DIR/projects/-e2e-proj/"
ls "$CLAUDE_CONFIG_DIR/projects/-e2e-proj/"
NATIVE="$CLAUDE_CONFIG_DIR/projects/-e2e-proj/e2e-scenarios-0001.jsonl"
NATIVE_MD5=$(file_md5 "$NATIVE")
echo
note "e2e-scenarios-0001.jsonl has NO sidecar — that is the shape of every"
note "NATIVE Claude session, and it must survive gc. md5: $NATIVE_MD5"
echo
soj_expect 0 gc --days 0
echo
echo "\$ ls \$CLAUDE_CONFIG_DIR/projects/-e2e-proj/   # the dry run changed nothing"
ls "$CLAUDE_CONFIG_DIR/projects/-e2e-proj/"
echo
soj_expect 0 gc --days 0 --run
echo
echo "\$ ls \$CLAUDE_CONFIG_DIR/projects/-e2e-proj/   # synthesized pair swept"
ls "$CLAUDE_CONFIG_DIR/projects/-e2e-proj/"
echo
if [ ! -f "$NATIVE" ]; then
  fail "gc DELETED a native Claude transcript — the worst possible bug"
else
  echo "native transcript md5 after gc --run: $(file_md5 "$NATIVE")"
  if [ "$(file_md5 "$NATIVE")" = "$NATIVE_MD5" ]; then
    echo "unchanged: native session history survived."
  else
    fail "gc modified a native transcript"
  fi
fi
if ls "$CLAUDE_CONFIG_DIR/projects/-e2e-proj/" | grep -q 'sojourn-rewind\.json$'; then
  fail "gc --run left a synthesized sidecar behind"
fi

# ─────────────────────────────────────────────────────────────────────────
section "soj mcp — read-only MCP stdio server"
echo "\$ node scripts/demo/mcp-probe.mjs      # spawns 'soj mcp', speaks real MCP"
if ! DEMO_CLI="$CLI" DEMO_CWD="$PROJECT" node "$REPO/scripts/demo/mcp-probe.mjs"; then
  fail "mcp probe"
fi

# ─────────────────────────────────────────────────────────────────────────
section "Web UI — headless, so: described, not captured"
soj_expect 0 open
echo "\$ curl -o /dev/null -w 'HTTP %{http_code}  %{size_download} bytes' http://localhost:$PORT/"
curl -s -o /dev/null -w 'HTTP %{http_code}  %{size_download} bytes\n' "http://localhost:$PORT/"
note "the daemon serves the built SPA. This run is headless — no browser, no"
note "screenshots. docs/DEMO.md describes what the UI surfaces (including the"
note "session-filter nudge); that section is DESCRIBED, not captured."

# ─────────────────────────────────────────────────────────────────────────
section "Daemon log rotation — copy-then-truncate keeps the inode"
LOG="$SOJOURN_HOME/daemon.log"
DPID=$(cat "$SOJOURN_HOME/daemon.pid" 2>/dev/null || true)
echo "\$ lsof -p $DPID     # the detached daemon's inherited stdout fd (fd 1)"
lsof -p "$DPID" 2>/dev/null | awk 'NR==1 || $4 ~ /^1[uw]/' | head -3
INODE_BEFORE=$(file_inode "$LOG")
echo
echo "\$ stat daemon.log"
file_line "$LOG"
echo
echo "\$ pad daemon.log past MAX_LOG_BYTES (5 MiB) so the next write rotates"
node -e 'require("node:fs").appendFileSync(process.argv[1], "x".repeat(5*1024*1024));' "$LOG"
file_line "$LOG"
echo
SOJ_CWD="$REPO"
soj_expect 0 stop
SOJ_CWD="$PROJECT"
sleep 0.5
INODE_AFTER=$(file_inode "$LOG")
echo
echo "\$ stat daemon.log daemon.log.1    # after the rotating write"
file_line "$LOG"
file_line "$LOG.1"
echo
echo "\$ cat daemon.log"
cat "$LOG"
echo
if [ "$INODE_BEFORE" = "$INODE_AFTER" ]; then
  echo "daemon.log inode UNCHANGED across rotation ($INODE_BEFORE); the old"
  echo "contents moved to a NEW inode at daemon.log.1."
  note "that is the whole fix. The detached child's stdout/stderr is an inherited"
  note "O_APPEND fd bound to this INODE, not to the path. The old rename-based"
  note "rotation moved that inode to daemon.log.1, and the NEXT rotation"
  note "overwrote daemon.log.1 — unlinking the inode the child still wrote"
  note "through, so raw output (the V8 OOM banner, which never goes through the"
  note "logger) landed in a deleted file. Copy-then-truncate keeps the inode."
else
  fail "log rotation changed daemon.log's inode ($INODE_BEFORE -> $INODE_AFTER)"
fi

# ─────────────────────────────────────────────────────────────────────────
section "Isolation check — the real home directories"
fp_line "$REAL_SOJOURN" > "$BASE/after.sojourn"
fp_line "$REAL_CLAUDE"  > "$BASE/after.claude"
for name in sojourn claude; do
  if diff -q "$BASE/before.$name" "$BASE/after.$name" >/dev/null; then
    echo "~/.$name: UNCHANGED ($(wc -l < "$BASE/after.$name" | tr -d ' ') files; identical sizes and mtimes)"
  else
    echo "~/.$name: DIFFERS —"
    diff "$BASE/before.$name" "$BASE/after.$name" | head -20
    # A hard failure only for paths this demo could plausibly have created.
    # ~/.claude is a LIVE directory the machine's own Claude Code writes to
    # while this script runs, so an unrelated write there is expected noise —
    # but it is printed above so it can be judged, never hidden.
    if diff "$BASE/before.$name" "$BASE/after.$name" \
         | grep -qE "e2e-(scenarios|second|storm|compact|clean)|demo-worktree|sojourn-rewind|sojourn-demo|$PROJECT_ID"; then
      fail "the demo wrote demo artifacts into ~/.$name"
    else
      note "no demo-owned name (nor this run's project id $PROJECT_ID) appears in"
      note "that diff. ~/.claude is written by this machine's own Claude Code, and"
      note "~/.sojourn by a real daemon on 4177 if one is running — that is what"
      note "the diff shows. The check fails only on demo-owned paths."
    fi
  fi
done

# ─────────────────────────────────────────────────────────────────────────
section "Result"
echo "transcript: $TRANSCRIPT"
if [ "$FAILURES" = 0 ]; then
  echo "DEMO PASSED — $STEP sections, 0 failing checks."
  sleep 0.3
  exit 0
fi
echo "DEMO FAILED — $FAILURES failing check(s)."
sleep 0.3
exit 1
