#!/bin/bash
# Sojourn E2E cycle: build -> unit suite -> isolated daemon -> staged
# scenario session -> full-surface API check. Exits non-zero on ANY failure.
#
# Isolation: own SOJOURN_HOME, own CLAUDE_CONFIG_DIR, own port — a live
# daemon on 4177 is never touched.
#
# Flags: --skip-build  --skip-unit  --keep (leave daemon+dirs up for UI checks)
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${E2E_PORT:-4199}"
SKIP_BUILD=0; SKIP_UNIT=0; KEEP=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --skip-unit) SKIP_UNIT=1 ;;
    --keep) KEEP=1 ;;
  esac
done

BASE=$(mktemp -d /tmp/sojourn-e2e-cycle.XXXXXX)
export SOJOURN_HOME="$BASE/home"
export CLAUDE_CONFIG_DIR="$BASE/claude"
export SOJOURN_PORT="$PORT"
export E2E_PORT="$PORT"
export E2E_PROJECT="$BASE/proj"
export E2E_CLAUDE_DIR="$CLAUDE_CONFIG_DIR"
export E2E_OUT="$BASE/manifest.json"
export E2E_REPORT="${E2E_REPORT:-$BASE/report.json}"
mkdir -p "$SOJOURN_HOME" "$CLAUDE_CONFIG_DIR/projects" "$E2E_PROJECT"
echo "[cycle] base=$BASE port=$PORT"

fail() { echo "[cycle] FAILED at: $1"; exit 1; }

if [ "$SKIP_BUILD" = 0 ]; then
  (cd "$REPO" && npm run build >/dev/null 2>&1) || fail "build"
  echo "[cycle] build ok"
fi

if [ "$SKIP_UNIT" = 0 ]; then
  (cd "$REPO" && npx vitest run >"$BASE/unit.log" 2>&1) || { tail -20 "$BASE/unit.log"; fail "unit suite"; }
  echo "[cycle] unit suite ok"
fi

# Claim the port: a previous --keep run (or a crashed daemon) must not
# leave a stale listener that silently absorbs our traffic.
STALE=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
if [ -n "$STALE" ]; then
  echo "[cycle] killing stale listener(s) on :$PORT — $STALE"
  kill $STALE 2>/dev/null
  sleep 0.5
fi

node "$REPO/packages/daemon/dist/main.js" >"$BASE/daemon.log" 2>&1 &
DPID=$!
[ "$KEEP" = 0 ] && trap 'kill $DPID 2>/dev/null' EXIT

healthy=0
for i in $(seq 1 50); do
  curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1 && { healthy=1; break; }
  sleep 0.2
done
[ "$healthy" = 1 ] || { tail -20 "$BASE/daemon.log"; fail "daemon health"; }
echo "[cycle] daemon up (pid $DPID)"

node "$REPO/scripts/e2e/gen-session.mjs" || { tail -30 "$BASE/daemon.log"; fail "scenario generation"; }
echo "[cycle] scenario session generated"

node "$REPO/scripts/e2e/api-check.mjs"
STATUS=$?
echo "[cycle] report: $E2E_REPORT"
if [ "$KEEP" = 1 ]; then
  echo "[cycle] --keep: daemon pid $DPID still running on port $PORT, base $BASE"
  echo "$DPID" > "$BASE/daemon.pid"
fi
exit $STATUS
