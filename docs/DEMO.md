# Sojourn — end-to-end demo

One command, a real daemon, real output.

```bash
bash scripts/demo/run-demo.sh
```

`--skip-build` reuses the existing `dist/`. `--keep` leaves the temp directory
and its daemon running so you can poke at them. The script exits non-zero if
**any** step deviates from its expected result.

**Everything quoted below was captured from a real run of that script** on
darwin, Node 22, at commit-time of v1.2.0. Nothing here was reconstructed from
memory or prettied up. Where a feature could not be exercised in a headless
environment, this document says so instead of inventing a transcript — see
[What this demo does NOT prove](#what-this-demo-does-not-prove) at the end,
which is the most important section here.

One honest caveat about the quoting: the blocks below come from **more than one
real run** — the combine section and the isolation/result blocks are from the
run that added combine, the rest from the run before it. Every run provisions a
fresh temp home, so the temp path, the project id, node uuids and the real-home
file counts differ between blocks. That is a bookkeeping artifact of when each
block was captured, not a sign that anything was edited: no block was retouched
to match another.

---

## The isolation guarantee

The demo never touches your real Sojourn or Claude state. It provisions its own
`SOJOURN_HOME`, its own `CLAUDE_CONFIG_DIR`, and its own port under a fresh
`mktemp -d`, and it fingerprints both real home directories (path + size +
mtime for every file) before and after, then diffs them.

```
[1] Isolation
repo:              /Users/vivekgade/Documents/sojourn
temp base:         $BASE = /private/tmp/sojourn-demo.2zLavf
SOJOURN_HOME:      $BASE/home
CLAUDE_CONFIG_DIR: $BASE/claude
port:              4211   (a daemon on the default 4177 is untouched)

fingerprinted the REAL dirs (path + size + mtime per file) so the run can
prove it left them alone:
  ~/.sojourn: 30106 files
  ~/.claude:  2562 files
```

and at the end of the same run:

```
[23] Isolation check — the real home directories
~/.sojourn: UNCHANGED (30106 files; identical sizes and mtimes)
~/.claude: DIFFERS —
923c923
< /Users/vivekgade/.claude/jobs/8c94d25a/state.json 3568 1784523108
---
> /Users/vivekgade/.claude/jobs/8c94d25a/state.json 3738 1784523135
    (no demo-owned name (nor this run's project id f63b88f51fd6) appears in
     that diff. ~/.claude is written by this machine's own Claude Code, and
     ~/.sojourn by a real daemon on 4177 if one is running — that is what
     the diff shows. The check fails only on demo-owned paths.)
```

Be honest about what that second block is: `~/.claude` is a **live** directory
that the Claude Code session running on the machine writes to continuously, so
a byte-identical before/after is not achievable and claiming one would be a
lie. The check therefore prints the whole diff — so you can judge it — and
hard-fails only if a demo-owned name (`e2e-*`, `demo-worktree-*`,
`*.sojourn-rewind.json`, or this run's project id) shows up in it. In the run
above the only change is this Claude Code session's own job state file.

> `pwd -P` in the script is load-bearing. The daemon derives the project id
> from the path capture hands it; the CLI derives it from `process.cwd()`,
> which is always physical. On macOS `/tmp` is a symlink to `/private/tmp`, so
> a logical base path makes `soj flags` look up a different project than the
> one capture wrote to.

---

## 1. Daemon lifecycle — `soj start` / `soj status`

```
$ soj start
daemon started (pid 72067) at http://localhost:4211
[exit 0]
$ soj status
daemon: running (pid 72067, version 1.2.0) at http://localhost:4211
[exit 0]
```

## 2. Capture — a Claude session ingesting into the graph

The demo reuses `scripts/e2e/gen-session.mjs` rather than reimplementing it. It
synthesizes real Claude transcript JSONL and drives the daemon's hook route
turn by turn, mutating the project between turns, so every turn gets its own
snapshot and turn-scoped flag grounding is exercised for real. No live Claude
session is needed.

```
$ node scripts/e2e/gen-session.mjs      # (tail)
[gen] stage ok: storm setup turn (>= 45 nodes, 14 snaps)
[gen] stage ok: storm turn (ONE batch) (>= 59 nodes, 15 snaps)
[gen] stage ok: clean session (gate exit 0) (>= 62 nodes, 16 snaps)
[gen] stage ok: compaction session (>= 66 nodes, 17 snaps)
[gen] manifest written: /private/tmp/sojourn-demo.yur7qL/manifest.json
project id: e11fc634c1bb

$ soj projects
id            name  root                                   createdAt
e11fc634c1bb  proj  /private/tmp/sojourn-demo.yur7qL/proj  2026-07-19T22:11:21.403Z
[exit 0]
```

## 3. Flags — deterministic (T1) claim-vs-snapshot checks

Every line is a claim the assistant made that the snapshot record contradicts.

```
$ soj flags
kind                   tier      confidence  node              evidence
package_hallucination  verified  high        claude:e2e-a-016  claimed/used import of package `totally_unreal_pkg_zx91`; PyPI returned 404 (not found) for that package name
file_ref_missing       verified  medium      claude:e2e-a-018  claimed reference to `src/missing_config.py`; that path is not present in the snapshot tree
symbol_not_found       verified  high        claude:e2e-a-020  claimed symbol `frobnicate` in `src/app.py`; that file's content has no occurrence of `frobnicate`
test_claim_unverified  verified  medium      claude:e2e-a-022  claimed tests pass; no test run observed since last prompt
test_claim_unverified  verified  high        claude:e2e-a-027  claimed tests pass; observed failing run
edit_claim_mismatch    verified  high        claude:e2e-a-052  claimed edit to `src/storm.py`; the snapshot diff for this step is empty
file_ref_missing       verified  medium      claude:e2e-a-060  claimed reference to `src/ref_alpha.py`; that path is not present in the snapshot tree
file_ref_missing       verified  medium      claude:e2e-a-061  claimed reference to `src/ref_beta.py`; that path is not present in the snapshot tree
file_ref_missing       verified  medium      claude:e2e-a-062  claimed reference to `src/ref_gamma.py`; that path is not present in the snapshot tree
file_ref_missing       verified  medium      claude:e2e-a-064  claimed reference to `src/ref_delta.py`; that path is not present in the snapshot tree …and similar claims suppressed
[exit 0]
```

What to notice:

- **Truthful claims are absent.** The scenario also contains a truthful edit
  claim, a truthful "tests pass" backed by an observed passing run, and an
  earlier false edit claim that a later real edit **auto-resolved**. None of
  them appear. A checker that flags everything is worthless.
- **The last row ends in `…and similar claims suppressed`.** That is a
  *digest*: the flag-storm session made five distinct `file_ref_missing`
  claims in one turn; the per-kind budget kept three and collapsed the rest
  into one digest carrying the suppressed count, so a single bad turn cannot
  drown the list.

## 4. Tier-2 advisory critic — `soj critic`

T2 calls the Anthropic API **from the daemon**. With no key it refuses rather
than silently degrading to "looks fine":

```
$ soj critic claude:e2e-a-022
error: T2 requires ANTHROPIC_API_KEY
[exit 1]
```

This demo run had no `ANTHROPIC_API_KEY`, so **the T2 critic was never actually
exercised.** That is a genuine gap, restated at the end.

## 5. Decision memory — `soj mark`, `soj checkpoint`, `soj why`, `soj decisions`

```
$ soj mark "walrus config is the source of truth" --kind decision
marked claude:mark-1784499089266-itxc88iv [decision] "walrus config is the source of truth"
$ soj mark "assuming the retry budget is 3" --kind assumption
marked claude:mark-1784499089368-z5kx813w [assumption] "assuming the retry budget is 3"
$ soj checkpoint "pre-refactor"
marked claude:mark-1784499089470-5alnvlzn [checkpoint] "pre-refactor"
```

`soj why` is an FTS5 query over prompts, assistant gists, marks and
annotations; `--file` narrows it to turns that touched a path, via the
per-turn files-touched index:

```
$ soj why walrus
[prompt] claude:e2e-u-043  Where does the walrus dance?
    Where does the walrus dance?
[decision] claude:mark-1784499089266-itxc88iv  walrus config is the source of truth
    walrus config is the source of truth walrus config is the source…
[assistant] claude:e2e-a-044  The dance config lives in `src/walrus.py` and hums quietly.
    The dance config lives in `src/walrus.py` and hums quietly.
[exit 0]

$ soj why walrus --file src/walrus.py
[prompt] claude:e2e-u-043  Where does the walrus dance?
    Where does the walrus dance?
[assistant] claude:e2e-a-044  The dance config lives in `src/walrus.py` and hums quietly.
    The dance config lives in `src/walrus.py` and hums quietly.
[exit 0]
```

`soj decisions` is the durable record: marks first, then every turn carrying an
active flag, each with its evidence line.

```
$ soj decisions
[checkpoint] claude:mark-1784499089470-5alnvlzn  pre-refactor
[assumption] claude:mark-1784499089368-z5kx813w  assuming the retry budget is 3
[decision] claude:mark-1784499089266-itxc88iv  walrus config is the source of truth
[assistant] claude:e2e-a-064  The retry policy is documented in `src/ref_epsilon.py` for operators.  ⚑ file_ref_missing
    ⚑ file_ref_missing (verified/medium): claimed reference to `src/ref_delta.py`; that path is not present in the snapshot tree …and similar claims suppressed
[assistant] claude:e2e-a-062  The retry policy is documented in `src/ref_gamma.py` for operators.  ⚑ file_ref_missing
    ⚑ file_ref_missing (verified/medium): claimed reference to `src/ref_gamma.py`; that path is not present in the snapshot tree
...
[assistant] claude:e2e-a-022  All tests pass.  ⚑ test_claim_unverified
    ⚑ test_claim_unverified (verified/medium): claimed tests pass; no test run observed since last prompt
[exit 0]
```

## 6. `soj gate` — CI exit codes

Three outcomes, three exit codes, and the third is the one that matters.

```
$ soj gate
checked: claims vs snapshots recorded by the local Sojourn daemon
gate failed: 10 active verified flag(s)
node              kind                   tier      confidence  evidence
claude:e2e-a-016  package_hallucination  verified  high        claimed/used import of package `totally_unreal_pkg_zx91`; PyPI returned 404 (no…
...
[exit 2]

$ soj gate --session e2e-clean-0005
checked: claims vs snapshots recorded by the local Sojourn daemon
gate passed: 1 turns, 0 active verified flags
[exit 0]

$ SOJOURN_PORT=4999 soj gate
checked: claims vs snapshots recorded by the local Sojourn daemon
sojourn daemon is not reachable at http://localhost:4999 — is it running? Try `soj start`. (exit 3 = could not check)
[exit 3]
```

Exit **3 is not exit 0**. An unreachable daemon means *could not check*, never
*clean*. Every line also starts with `checked: claims vs snapshots recorded by
the local Sojourn daemon` — the gate states the scope of its own authority
rather than implying it verified your code.

## 7. Rewind — exact-node rewind, and its refusal

Rewind reconstructs a *conversation* (not files) by synthesizing a brand-new
resumable transcript containing exactly the target node's ancestor chain.

```
$ curl -X POST /api/nodes/claude:e2e-a-044/rewind-plan      # clean ancestor chain
{"mode":"exact","newSessionId":"ca287f71-fb33-41ca-9777-54c70cf48a50","transcriptPath":"/private/tmp/sojourn-demo.yur7qL/claude/projects/-e2e-proj/ca287f71-fb33-41ca-9777-54c70cf48a50.jsonl","refusedReason":null,"resumeCommand":"claude --resume ca287f71-fb33-41ca-9777-54c70cf48a50"}

$ curl -X POST /api/nodes/claude:e2e-a-072/rewind-plan      # chain crosses a compaction boundary
{"mode":"tip","newSessionId":null,"transcriptPath":null,"refusedReason":"chain crosses a compaction/summary boundary; exact context cannot be reconstructed","resumeCommand":"claude --resume e2e-compact-0004 --fork-session"}
```

**The refusal is the feature.** The second node's ancestor chain crosses a
`type:"summary"` compaction marker: the context the model actually saw at that
point cannot be reconstructed from the transcript, so exact mode is refused,
`refusedReason` says exactly why, and the plan degrades to a native
`--fork-session` from the session tip. Sojourn would rather hand you a
lesser-but-true resume than fabricate a transcript.

Planning is **pure** — after both plans, nothing has been written:

```
$ ls $CLAUDE_CONFIG_DIR/projects/-e2e-proj/
e2e-clean-0005.jsonl
e2e-compact-0004.jsonl
e2e-scenarios-0001.jsonl
e2e-second-0002.jsonl
e2e-storm-0003.jsonl
```

Executing it writes a new file and leaves the original byte-identical:

```
$ curl -X POST /api/nodes/claude:e2e-a-044/rewind           # execute
{"mode":"exact","newSessionId":"b449ef5f-7e15-4379-bcb1-68aa8713f9b5","transcriptPath":".../b449ef5f-7e15-4379-bcb1-68aa8713f9b5.jsonl","refusedReason":null,"resumeCommand":"claude --resume b449ef5f-7e15-4379-bcb1-68aa8713f9b5"}

original transcript md5 before: 9929867a19910d17295fb0fb245415ce
original transcript md5 after:  9929867a19910d17295fb0fb245415ce
unchanged: rewind only ever creates NEW files.
```

> Building this demo surfaced a real defect on this path — executing an exact
> rewind used to re-key the origin session's `tool_use` nodes onto the
> synthesized session. It is **fixed**; see
> [Defects found while building this demo](#defects-found-while-building-this-demo).

## 8. Sidecar-before-transcript ordering

```
$ ls -l $CLAUDE_CONFIG_DIR/projects/-e2e-proj/
total 104
-rw-r--r--@ 1 vivekgade  wheel  12956 Jul 19 17:11 b449ef5f-7e15-4379-bcb1-68aa8713f9b5.jsonl
-rw-r--r--@ 1 vivekgade  wheel   1689 Jul 19 17:11 b449ef5f-7e15-4379-bcb1-68aa8713f9b5.sojourn-rewind.json
-rw-r--r--@ 1 vivekgade  wheel    820 Jul 19 17:11 e2e-clean-0005.jsonl
-rw-r--r--@ 1 vivekgade  wheel   1156 Jul 19 17:11 e2e-compact-0004.jsonl
-rw-r--r--@ 1 vivekgade  wheel  10391 Jul 19 17:11 e2e-scenarios-0001.jsonl
-rw-r--r--@ 1 vivekgade  wheel    497 Jul 19 17:11 e2e-second-0002.jsonl
-rw-r--r--@ 1 vivekgade  wheel   5056 Jul 19 17:11 e2e-storm-0003.jsonl

$ head -c 300 b449ef5f-7e15-4379-bcb1-68aa8713f9b5.sojourn-rewind.json
{
  "originSessionId": "e2e-scenarios-0001",
  "originNodeId": "claude:e2e-a-044",
  "lineUuids": [
    "3053c118-02c1-4f1b-9482-211b124ffa6d",
    ...
```

The synthesized transcript never carries provenance in its own lines —
`claude --resume` must load exactly native shape — so a sidecar is the only
channel telling ingest that this session forked off `originNodeId` and that
these line uuids are synthesized *history*, not fresh agent claims (T1 must
skip them, or a rewind would re-flag the past).

**Why the write order matters.** The sidecar is renamed into place *first*,
the transcript second. The daemon's watcher only reacts to `.jsonl`, so by the
time a transcript can be observed its sidecar is already durable. A crash in
the window between the two renames leaves at worst an **orphan sidecar**:
inert (nothing ingests a `.json`) and reclaimable by `soj gc`. The reverse
order would leave an **orphan transcript** — which the watcher would ingest as
a disconnected phantom session, re-running T1 over synthesized history and
manufacturing false *verified* flags.

## 9. Restore — preflight, then `--yes`

```
$ soj restore claude:e2e-a-044
Preflight warnings:
  - Bash side effects (commands the assistant ran) are NOT undone by this restore.
  - Database migrations are NOT undone by this restore.
  - Network calls (API requests, deployments, etc.) are NOT undone by this restore.
  - Git pushes to remotes are NOT undone by this restore.
  - Restore checks out files into a NEW worktree directory; your current working directory is left untouched.
Resume command: claude --resume e2e-scenarios-0001 --fork-session
Re-run with --yes to confirm the restore.
[exit 1]
```

Preflight exits **1** deliberately: nothing happened, so this is not success.
The warnings are the honest scope statement — a filesystem restore cannot undo
the world.

```
$ soj restore claude:e2e-a-044 --yes
Worktree: /private/tmp/sojourn-demo.yur7qL/home/worktrees/e11fc634c1bb/claudee2-20260719171132
Resume command: claude --resume e2e-scenarios-0001 --fork-session
Warning: Bash side effects (commands the assistant ran) are NOT undone by this restore.
...
[exit 0]

$ ls -a $WORKTREE
.
..
.sojourn-restore.json
package.json
src

$ cat $PROJECT/src/app.py    # the mainline project is untouched
def main():
    return 2  # fixed
```

The restore lands in a **new worktree**; your working directory is never
rewritten under you. `.sojourn-restore.json` is the manifest that ties that
worktree back to its origin node — it is what `soj harvest` reads.

## 10. Harvest — the return path

This is the new half of the loop: a restore takes you *back*, a harvest brings
work *forward*.

### Preflight, then apply

```
$ edit src/app.py INSIDE the restored worktree

$ soj harvest
Worktree: /private/tmp/sojourn-demo.yur7qL/home/worktrees/e11fc634c1bb/claudee2-20260719171132
Origin node: claude:e2e-a-044
Mainline: clean (unchanged on the paths this harvest touches)
status  file
clean   src/app.py
1 clean, 0 conflict, 0 identical
Preflight warnings:
  - A safety snapshot of the mainline project is taken before any harvest write.
  - Harvest writes file contents only — it never touches your project's .git.
Re-run with --yes to confirm the harvest.
[exit 1]
```

Note the wording: **"Mainline: clean (unchanged on the paths this harvest
touches)"**. It is not claiming your whole tree is clean — only that the
mainline has not moved on the paths this harvest would write.

```
$ soj harvest --yes
Applied (1):
  src/app.py
Skipped (identical, 0)
Safety snapshot: ce0c93ac979b79a94c1185e48442a247bd0e6c28
Merge node: claude:harvest-307f65aa-24c0-4895-8702-d2d92d7e5d91
[exit 0]

$ cat $PROJECT/src/app.py
def main():
    return 99  # harvested back from the worktree
```

The **safety snapshot** is the pre-harvest mainline state, captured before any
write. The **merge node** joins the harvest back into the graph, parented to
the node the worktree was restored from, so the round trip is a first-class
part of the history rather than an untracked side channel.

### `--mode patch` — mainline untouched

```
$ soj harvest --mode patch --yes
Patch: .../claudee2-20260719171132/.sojourn-harvest.patch
Safety snapshot: c6475568acf34053d3bd9584a2d719fe69f58be9
[exit 0]

$ cat $WORKTREE/.sojourn-harvest.patch
diff --git a/src/app.py b/src/app.py
index d3ed8ad..3ba3fdd 100644
--- a/src/app.py
+++ b/src/app.py
@@ -1,2 +1,2 @@
 def main():
-    return 2  # fixed
+    return 123  # patch-mode edit

$ cat $PROJECT/src/app.py    # unchanged — patch mode wrote nothing here
def main():
    return 99  # harvested back from the worktree
```

Notice what patch mode does **not** print: no `Applied (0)`, no
`Skipped (identical, 0)`. In patch mode the `applied`/`conflicted`/
`skippedIdentical` arrays are *always* empty by construction, so reporting
"0 files applied" for a successful patch run would be a lie about what
happened. The CLI branches on `patchPath !== null` and prints only the two
facts that are real.

The same principle applies to flag combinations. `--allow-conflicts` is
meaningless in patch mode (a patch never writes markers into the mainline), and
the daemon silently ignores it — so the CLI refuses it up front instead of
accepting a flag that does nothing:

```
$ soj harvest --mode patch --allow-conflicts --yes
error: --allow-conflicts applies to --mode apply only (a patch never writes conflict markers into the mainline).
[exit 1]
```

### A conflict aborts CLEAN

Now the mainline and the worktree both move on the same file, differently.

```
$ soj harvest
...
Mainline: dirty (moved on a path this harvest touches)
status    file
conflict  src/app.py
0 clean, 1 conflict, 0 identical
Preflight warnings:
  - A safety snapshot of the mainline project is taken before any harvest write.
  - Conflicted files (require allowConflicts or manual resolution): src/app.py
  - Harvest writes file contents only — it never touches your project's .git.
Re-run with --yes to confirm the harvest.
[exit 1]

$ soj harvest --yes
error: Harvest aborted: 1 conflicted file(s): src/app.py. No mainline files were written. Re-run with allowConflicts to write conflict markers, or use mode "patch".
files:
  src/app.py
Re-run with --allow-conflicts to write conflict markers, or --mode patch.
[exit 1]
```

The raw wire response, which is where the honesty surface actually lives:

```
$ curl -o body -w '%{http_code}' -X POST /api/worktrees/harvest -d '{...}'
HTTP 400
{"error":"Harvest aborted: 1 conflicted file(s): src/app.py. No mainline files were written. Re-run with allowConflicts to write conflict markers, or use mode \"patch\".","code":"conflicts","files":["src/app.py"]}

$ cat $PROJECT/src/app.py    # mainline untouched by the aborted harvest
def main():
    return 7  # MAINLINE moved independently
```

**The 400-vs-500 split is a contract, not a status-code aesthetic.** A `4xx`
from the harvest route is a promise that *provably zero mainline bytes were
written* — the failure was detected during planning/validation, before any
write began. A `5xx` makes no such promise. The `code` field
(`"conflicts"` here; also `no_manifest`, `read_failed`, …) is the stable
machine-readable classification; match on it, not on the prose.

And when you *do* want the markers, you ask for them explicitly:

```
$ soj harvest --yes --allow-conflicts
Applied (0):
Conflicted (1):
  src/app.py
Skipped (identical, 0)
Safety snapshot: 5c169e4a3dbf549b3f6ed1be760ce92590f8ddfb
Merge node: claude:harvest-c869b0f3-6495-4303-bd23-ffaf065991ab
[exit 0]

$ cat $PROJECT/src/app.py
def main():
<<<<<<< mainline
    return 7  # MAINLINE moved independently
=======
    return 8  # WORKTREE moved differently
>>>>>>> branch
```

### Harvest exit codes

| exit | meaning |
| --- | --- |
| 0 | success (apply or patch) |
| 1 | preflight (nothing written), any `4xx` from the daemon, or a local validation refusal such as `--allow-conflicts --mode patch` |
| 2 | a **`partial`** payload came back: the mainline **was** written before the failure. The applied/conflicted/remaining lists and the safety snapshot ref are dumped **to stderr**. |

Exit 2 is the loud one. It means the run got far enough to modify your project
and then failed, and the safety snapshot named in the dump is your pre-harvest
state. **The demo does not produce an exit 2** — a partial requires an
mid-apply I/O failure that cannot be induced from outside the process without
faking it, and faking it would defeat the point of this document. It is
documented from the source and covered by unit tests, not by this run.

## 11. Snapshot excludes — `.sojourn-restore.json` / `.sojourn-harvest.patch`

By this point the worktree physically contains both of Sojourn's own artifacts:

```
$ ls -a $WORKTREE
.
..
.sojourn-harvest.patch
.sojourn-restore.json
package.json
src
```

The demo then runs a session whose `cwd` **is** that worktree, so the tree
above is what gets snapshotted, and inspects the resulting snapshot directly:

```
$ node scripts/demo/gen-worktree-session.mjs
{"projectId":"e11fc634c1bb","nodeId":"claude:demo-worktree-0006-a-1","snapshotRef":"1e53159af537ffef35d278ba24909af474296354"}

$ git --git-dir=$SOJOURN_HOME/snapshots/e11fc634c1bb ls-tree -r --name-only 1e53159af537ffef35d278ba24909af474296354
package.json
src/app.py
src/auth.py
src/deps.py
src/walrus.py
```

Neither artifact is in the captured tree. Before this exclude, restoring a
worktree-session node would materialize a **stale** `.sojourn-harvest.patch`
into a fresh worktree — a file a user could reasonably `git apply` believing it
described their current work. Every real consumer reads these artifacts from
the live filesystem, never out of a snapshot, so excluding them costs nothing.

## 12. Combine — merging two sessions' file states

`soj combine <nodeIdA> <nodeIdB>` three-way merges the **file states** of two
graph nodes — typically from two *different* sessions — against their nearest
common ancestor, and materializes the result into one new worktree.

**It emits FILES ONLY. No conversation transcript is ever synthesized.** That is
the single most important thing to understand about this feature, and the demo
asserts it rather than asserting it in prose. Merging two conversations would
mean inventing an interleaving that never happened, which this project forbids
outright (`adapter-claude/src/rewind.ts`: *"Refusing is always preferred over
guessing"*). Neither source session is continued. You start a genuinely fresh
session in the output worktree, and Sojourn's existing worktree aliasing links
that session back to node A on its own.

### Building a real cross-session pair

The demo restores the same origin node twice and drives a separate session in
each worktree, so the two nodes it combines genuinely belong to different
sessions that diverged from a shared point:

```
node A — session demo-worktree-0006, snapshot of the FIRST worktree:
  claude:demo-worktree-0006-a-1

$ (cd $BASE/proj && soj restore claude:e2e-a-044 --yes)
Worktree: /private/tmp/sojourn-demo.2zLavf/home/worktrees/f63b88f51fd6/claudee2-20260719235227
Resume command: claude --resume e2e-scenarios-0001 --fork-session
[exit 0]

$ # three edits in the SECOND worktree, chosen to cover every status:
    src/combined_feature.py  — new file, only B has it
    src/walrus.py            — modified, only B moved it
    src/app.py               — set to EXACTLY what A already has

$ node scripts/demo/gen-worktree-session.mjs   # session demo-worktree-combine-0007
{"projectId":"f63b88f51fd6","nodeId":"claude:demo-worktree-combine-0007-a-1","snapshotRef":"40dfceefaacd751f6176244035679d793111688f"}

node B — session demo-worktree-combine-0007:
  claude:demo-worktree-combine-0007-a-1
```

### Preflight — dry by default, and the purest of the three

Like `restore` and `harvest`, no `--yes` means nothing happens and the exit code
says so. Combine's preflight is the *purest* of the three: `restore`'s preflight
validates a tree and `harvest`'s snapshots the live worktree into the shadow
repo, but combine's writes nothing anywhere — base, A and B are all pre-existing
trees, and the only filesystem activity is short-lived `os.tmpdir()` scratch for
`git merge-file -p` dry runs.

```
$ (cd $BASE/proj && soj combine claude:demo-worktree-0006-a-1 claude:demo-worktree-combine-0007-a-1)
Node A: claude:demo-worktree-0006-a-1
Node B: claude:demo-worktree-combine-0007-a-1
Merge base: claude:e2e-a-044
Trees: base dd2e6199762695f71d7e07e96355b7a4bf0239d9 | A 1e53159af537ffef35d278ba24909af474296354 | B 40dfceefaacd751f6176244035679d793111688f
status     file
clean      src/combined_feature.py
clean      src/walrus.py
identical  src/app.py
2 clean, 0 conflict, 1 identical
Preflight warnings:
  - Combine produces FILES ONLY. No conversation transcript is synthesized — start a genuinely fresh session in the output worktree; Sojourn will link it to node A automatically.
  - Combine writes file contents into a NEW worktree only — it never touches your project or its .git.
Re-run with --yes to confirm the combine.
[exit 1]
```

`Merge base: claude:e2e-a-044` is the node both sessions branched from, resolved
through the same shared `findEffectiveTree` that restore and GC's pinning use —
combine cannot drift from them about what tree a node stands for.

### The refusals

```
$ (cd $BASE/proj && soj combine claude:demo-worktree-0006-a-1 claude:demo-worktree-0006-a-1)
error: cannot combine a node with itself — nodeIdA and nodeIdB are both claude:demo-worktree-0006-a-1
[exit 1]
```

The CLI catches that locally so the obvious mistake costs zero round-trips; the
daemon rejects it too, with a plain 400 carrying **no** `code` — body validation
never reaches the engine, and only the engine's own refusals are typed.

```
$ curl -o body -w '%{http_code}' -X POST /api/nodes/combine/preflight \
    -d '{"nodeIdA":"claude:demo-worktree-0006-a-1","nodeIdB":"claude:e2e-a-046"}'
HTTP 400
{"error":"Nodes claude:demo-worktree-0006-a-1 and claude:e2e-a-046 have no common ancestor — there is no shared state to merge against. Refusing to guess a merge base.","code":"no_common_ancestor","files":[]}
```

That second node belongs to session `e2e-second-0002` — an unrelated session
root whose ancestor chain never meets node A's. (The `e2e-a-` prefix says
nothing about ownership: the generator mints ids from one counter shared across
all five sessions.) With no common ancestor there is no shared state to merge
against, so combine refuses instead of guessing a merge base. Every typed
combine error except `write_failed` is raised *before* an output directory is
even claimed, so all of them are provably zero-write.

### The combine itself

```
$ (cd $BASE/proj && soj combine claude:demo-worktree-0006-a-1 claude:demo-worktree-combine-0007-a-1 --yes)
Worktree: /private/tmp/sojourn-demo.2zLavf/home/worktrees/f63b88f51fd6/combine-claudede-claudede-20260719235228
Merge base: claude:e2e-a-044
Applied (2):
  src/combined_feature.py
  src/walrus.py
Skipped (identical, 1)
Combine node: claude:combine-258ce5a8-0cef-4caf-b732-dca22670462c
Warning: Combine produces FILES ONLY. No conversation transcript is synthesized — start a genuinely fresh session in the output worktree; Sojourn will link it to node A automatically.
Warning: Combine writes file contents into a NEW worktree only — it never touches your project or its .git.
[exit 0]
```

The worktree really exists, and really carries both sides:

```
$ ls -a $COMBINE_WT
.
..
.sojourn-restore.json
package.json
src

$ cat $COMBINE_WT/src/app.py             # A's side, kept
def main():
    return 8  # WORKTREE moved differently
$ cat $COMBINE_WT/src/walrus.py          # B's side, applied
WALTZ = True
TEMPO = "andante"  # only the SECOND session changed this
$ cat $COMBINE_WT/src/combined_feature.py   # B's new file, applied
def combined():
    return "from the SECOND session"
```

One tree carrying both sessions' work — and neither source worktree, nor the
mainline project, was written to. A's tree supplies the starting content and
B's changes are merged on top; everything outside the new worktree is a
read-only input.

### The graph stays a tree

```
$ curl -s /api/projects/$PROJECT_ID/graph | # find the combine node
  id kind parentId meta.mergedFrom
  claude:combine-258ce5a8-0cef-4caf-b732-dca22670462c checkpoint claude:demo-worktree-0006-a-1 claude:demo-worktree-combine-0007-a-1
```

`parentId` is node A and **only** node A. The second ancestor rides in
`meta.mergedFrom` (backed by schema migration **V4**'s `nodes.merged_from`
column) as provenance, not as a structural edge. Converting Sojourn to a DAG
would have forced new semantics on `findEffectiveTree`, GC's `collectPins`,
rewind's ancestor walk and the web layout all at once; recording the second
ancestor as provenance buys the traceability without any of that. **Sojourn is
not a DAG, and combine does not give a node two parents.**

### The honesty boundary — asserted, not asserted-to

The demo lists every `.jsonl` in the watched Claude project directory
immediately before the combine and again after it:

```
$ ls $CLAUDE_CONFIG_DIR/projects/-e2e-proj/*.jsonl    # BEFORE the combine
a2a4eaf0-9dc4-4ffb-9efa-babff029a87a.jsonl
b2959b41-563b-4fe2-9106-621a75247583.jsonl
b54f3205-e2cf-4262-9413-506a1703fcd3.jsonl
demo-worktree-0006.jsonl
demo-worktree-combine-0007.jsonl
e2e-clean-0005.jsonl
e2e-compact-0004.jsonl
e2e-scenarios-0001.jsonl
e2e-second-0002.jsonl
e2e-storm-0003.jsonl

$ ls $CLAUDE_CONFIG_DIR/projects/-e2e-proj/*.jsonl    # AFTER the combine
a2a4eaf0-9dc4-4ffb-9efa-babff029a87a.jsonl
b2959b41-563b-4fe2-9106-621a75247583.jsonl
b54f3205-e2cf-4262-9413-506a1703fcd3.jsonl
demo-worktree-0006.jsonl
demo-worktree-combine-0007.jsonl
e2e-clean-0005.jsonl
e2e-compact-0004.jsonl
e2e-scenarios-0001.jsonl
e2e-second-0002.jsonl
e2e-storm-0003.jsonl

IDENTICAL — the combine created no transcript at all.
```

Compare that with §7–§8, where an exact rewind *does* write a new transcript
(plus its sidecar) and the demo shows both new files appearing on disk. Rewind can synthesize a
transcript because it is a faithful **subset** of one real conversation. Combine
cannot, because there is no real conversation to be faithful to — so it doesn't,
and the list is byte-identical. A reader who walks away thinking `soj combine`
hands them a merged conversation has been misled; this check exists so the
document can never imply that.

### What the demo does not exercise here

- **No conflict was produced.** The pair was constructed to be clean, so
  `--allow-conflicts`, the `conflicts` 400 and the `unmarkable` list are not
  captured above. They are covered by unit tests. `unmarkable` is not a
  synonym for `conflicted` and the CLI prints them as separate blocks:
  a `conflicted` path was written **with** conflict markers, while an
  `unmarkable` one could not take markers at all (binary content on some side),
  so node A's materialized content was kept verbatim and **B's side is not
  present in the output worktree**. Unmarkable paths are reported in *both*
  lists — they are conflicts, and the extra list is what tells you which of
  them silently kept A.
- **No `write_failed` (exit 2).** That needs a mid-write I/O failure, which
  cannot be induced from outside the process without faking it. It is the only
  combine error that leaves a half-built worktree on disk, and that worktree is
  deliberately **not** deleted — it holds real merged content, and deleting it
  would make combine a source of data loss.

## 13. `soj gc` — transcript sweep, dry-run by default

Before:

```
$ ls $CLAUDE_CONFIG_DIR/projects/-e2e-proj/
b449ef5f-7e15-4379-bcb1-68aa8713f9b5.jsonl
b449ef5f-7e15-4379-bcb1-68aa8713f9b5.sojourn-rewind.json
demo-worktree-0006.jsonl
e2e-clean-0005.jsonl
e2e-compact-0004.jsonl
e2e-scenarios-0001.jsonl
e2e-second-0002.jsonl
e2e-storm-0003.jsonl
```

`e2e-scenarios-0001.jsonl` has **no sidecar**. That is the shape of every
*native* Claude session — and the single most important thing this demo checks
is that gc never touches it. Its md5 before the sweep:
`9929867a19910d17295fb0fb245415ce`.

```
$ soj gc --days 0
note: daemon is running (pid 72067) — if capture writes a snapshot while gc runs, gc will abort safely without pruning; re-run soj gc later to complete it.
project: proj (e11fc634c1bb)
keep window: 0 day(s)   pinned trees: 4
        commits
kept    16
pruned  3
       transcripts
kept   0
swept  1
reclaimable (estimate): 0 B (snapshots) + 14.3 KB (synthesized transcripts: 1 pair(s), 0 orphan sidecar(s))
dry run only — nothing was deleted. Re-run with --run to execute.
[exit 0]
```

**Dry run is the default, and it is a real dry run** — the directory listing
after it is byte-for-byte the listing above. The estimate is labelled
`reclaimable (estimate)`, not `reclaimed`. `pinned trees: 4` counts the
snapshot trees gc refuses to prune — waypoints (marked decisions, assumptions,
checkpoints, flagged nodes) plus any tree a live restore worktree still
references via its `.sojourn-restore.json` manifest.

```
$ soj gc --days 0 --run
...
reclaimed: 212.0 KB (snapshots) + 14.3 KB (synthesized transcripts: 1 pair(s), 0 orphan sidecar(s))
gc complete.
[exit 0]

$ ls $CLAUDE_CONFIG_DIR/projects/-e2e-proj/   # synthesized pair swept
demo-worktree-0006.jsonl
e2e-clean-0005.jsonl
e2e-compact-0004.jsonl
e2e-scenarios-0001.jsonl
e2e-second-0002.jsonl
e2e-storm-0003.jsonl

native transcript md5 after gc --run: 9929867a19910d17295fb0fb245415ce
unchanged: native session history survived.
```

### The negative result is the point

All five native transcripts survive `--run` untouched, and the one with a
sidecar — the pair Sojourn itself synthesized — is gone. That asymmetry is the
whole safety property.

The sweep's classifier has four states, and only two of them are ever deletion
candidates: `paired` (synthesized transcript + its sidecar) and
`orphan_sidecar` (inert residue from a crash). `orphan_transcript` — a `.jsonl`
with no sidecar — is **the ordinary shape of every real user session** and can
never reach the deletion code. `unreadable_sidecar` is skipped too: a
half-written sidecar is not proof the transcript is ours. A bug in that guard
would delete real human history, which is why it gets a demo step of its own
rather than a test-suite line.

Deletion order mirrors the write order: sidecar first, then transcript. A
failure between them leaves an inert orphan sidecar the next sweep reclaims —
never a sidecar-less synthesized transcript, which is the phantom-session
hazard again.

## 14. `soj mcp` — read-only MCP stdio server

`scripts/demo/mcp-probe.mjs` spawns `soj mcp` and speaks real MCP over stdio:
`initialize` → `notifications/initialized` → `tools/list` → one `tools/call`.

```
$ node scripts/demo/mcp-probe.mjs
initialize ok: server sojourn 1.2.0
tools/list -> 4 tools:
  sojourn_search  —  Read-only full-text search over the sojourn decision graph for this repo: prompts, assistant gists, decisions/assumptions/checkpoints, and annotations, plus a files-touched index. Returns hits ordered by relevance (best first). Use it to answer "why/when did we do X?" from prior sessions.
  sojourn_decisions  —  Read-only list of the durable record for a project: marked decisions, assumptions, and checkpoints, plus any nodes carrying active (unresolved, undismissed) flags.
  sojourn_flags  —  Read-only list of active flags (assumption/hallucination findings with evidence) for the current project, optionally filtered to one session. `verified` flags are deterministic ground-truth checks; `advisory` flags are hedged LLM-critic output.
  sojourn_node  —  Read-only fetch of a single graph node by id ("<cli>:<uuid>"), including its flags and annotations.
tools/call sojourn_flags -> first lines of result:
  {
    "projectId": "e11fc634c1bb",
    "sessionId": null,
    "flags": [
```

All four tools are read-only. Register it with
`claude mcp add sojourn -- soj mcp`. This probe proves the server starts,
handshakes, advertises its tools and answers a call — it does **not** prove
anything about a real Claude Code client's behaviour against it.

## 15. The terminal flag-delivery race

```
$ curl -s /api/sessions/e2e-storm-0003/turn-flags
{"lines":["edit_claim_mismatch: claimed edit to `src/storm.py`; the snapshot diff for this step is empty","file_ref_missing: claimed reference to `src/ref_alpha.py`; that path is not present in the snapshot tree","file_ref_missing: claimed reference to `src/ref_beta.py`; that path is not present in the snapshot tree","+2 more"]}
```

That route is what the `Stop` hook reads, on a **500 ms** budget, to print
flags in your terminal at end of turn. Here is the honest problem with it:

The hook `POST`s the rescan that *produces* the current turn's flags, then —
in the same 3.5 s hard-exit budget — issues a 500 ms `GET` for them. It is
racing the very work it just triggered. Ingest, snapshot, and the flag pass
usually have not finished, so what you see in the terminal is typically the
**previous** turn's state, and on a slow turn you see nothing at all. Every
failure mode (daemon down, non-200, malformed body, timeout) resolves to an
empty array, deliberately, so the hook never breaks your session.

**Therefore: hook silence is never a clean bill of health.** The authoritative
surfaces are `soj flags`, `soj gate`, and the web UI, all of which read the
graph after it has settled.

## 16. The web UI — described, not captured

```
$ soj open
http://localhost:4211
$ curl -o /dev/null -w 'HTTP %{http_code}  %{size_download} bytes' http://localhost:4211/
HTTP 200  392 bytes
```

That is the entire captured evidence for the UI: the daemon serves the built
SPA. **This run is headless — no browser, no screenshots, no rendered
assertions.** Everything below is described from the source, and you should
treat it as such.

The UI shows the session graph as a timeline of turns, with flagged nodes
marked and an inspector for the selected node (its gist, files touched, flags
with evidence, annotations, and the snapshot ref). Nodes that have a usable
snapshot are highlighted as restore points; the "Restorable" filter isolates
exactly those, and restore is disabled on nodes that cannot be restored rather
than offered and then failing. A daemon-disconnect banner appears when the
WebSocket drops and clears itself on reconnect.

**The session-filter nudge** (new this cycle) is a small honesty fix worth
naming precisely. Sessions can be filtered; the selection persists. If new
sessions arrive that your filter hides, a banner appears:

> `N new sessions aren't shown — your session filter is hiding them.`
> with a "Show them" action and a dismiss.

The guard is the interesting part: it fires **only** when there is an explicit
stored selection. On the default path (no stored selection) the view
re-defaults to the newest session, so a new session is shown automatically and
there is nothing to nudge about — a banner there would be noise. Without the
nudge, a user who once filtered sessions could stare at a stale view believing
it was current.

I did not render any of this. Run `soj open` against a real project to see it.

## 17. Daemon log rotation — copy-then-truncate keeps the inode

```
$ lsof -p 72067     # the detached daemon's inherited stdout fd (fd 1)
COMMAND   PID      USER   FD      TYPE             DEVICE  SIZE/OFF                NODE NAME
node    72067 vivekgade    1w      REG               1,18       305            16803478 /private/tmp/sojourn-demo.yur7qL/home/daemon.log

$ stat daemon.log
  .../home/daemon.log  inode=16803478  size=305

$ pad daemon.log past MAX_LOG_BYTES (5 MiB) so the next write rotates
  .../home/daemon.log  inode=16803478  size=5243185

$ soj stop
daemon stopped (pid 72067)

$ stat daemon.log daemon.log.1    # after the rotating write
  .../home/daemon.log    inode=16803478  size=77
  .../home/daemon.log.1  inode=16804247  size=5243185

$ cat daemon.log
2026-07-19T22:11:34.912Z [info] [sojourn] received SIGTERM — shutting down
```

The rotation is real: the log crossed 5 MiB, the next log line (the SIGTERM
shutdown notice) triggered it, 5 MiB moved to `daemon.log.1`, and the live file
now holds one line.

**`daemon.log` kept its inode — 16803478 before and after.** That is the entire
fix, and the `lsof` line above is why it matters: when the CLI starts the
daemon detached it opens `daemon.log` with `O_APPEND` and hands that fd to the
child as **both stdout and stderr**. That fd is bound to the *inode*, not the
path. Raw process output — a V8 OOM banner, a native abort, anything printed
outside the logger — goes through it and only through it.

The old rotation used `rename`. That moved the child's inode to
`daemon.log.1`, splitting structured lines from raw crash output across two
files; and the *next* rotation overwrote `daemon.log.1`, unlinking the inode
the child's fd still pointed at. From then on the OOM banner — the exact
symptom the rotating log exists to capture — was written into a deleted file
and lost. Copy-then-truncate keeps the inode alive and shared, and `O_APPEND`
recomputes the offset on every write so the child resumes at the new end with
no sparse gap.

**What this step does not show:** it does not force a post-rotation *raw*
write. The daemon only writes raw stdout on a crash, and inducing a genuine V8
OOM inside this harness was out of scope. What is captured is inode stability
plus proof (via `lsof`) that the detached child's fd is bound to that inode —
which is the property the rename version lacked. The rest is inference from
POSIX semantics, and unit tests in `packages/daemon/test/logger.test.ts` cover
the rotation mechanics directly.

---

## Result

```
[24] Result
transcript: /tmp/sojourn-demo-transcript.txt
DEMO PASSED — 24 sections, 0 failing checks.
```

---

## Defects found while building this demo

Running the demo is what surfaced these. Both are now fixed; they are kept here
because the failure modes are worth understanding.

**FIXED — executing an exact rewind stole the origin session's `tool_use` nodes.**
The synthesized transcript freshened every line uuid but reused the original
`tool_use` block ids verbatim. Ingest keys tool nodes on those block ids
(`parser.ts`: `nativeUuid: block.id` → `id: nodeIdFor(nativeUuid)`), so
upserting the synthesized session *moved* those nodes onto the new session id.
Observed directly at the time:

```
t-039: {"id":"claude:e2e-t-039","sessionId":"b27a9d4c-…","kind":"tool_use", …}
```

after a rewind whose origin was session `e2e-scenarios-0001`. Two consequences:
the origin session's graph lost its tool nodes, and its ancestor chains broke,
so a *subsequent* exact rewind of that session was refused with
`"ancestor chain incomplete (orphaned parentage)"` — a false refusal. Restore
was affected too, since its rewind companion executes an exact rewind.

The fix freshens tool block ids as well as line uuids, remapping `tool_use.id`
and the referring `tool_result.tool_use_id` through one shared map so the
tool_result → tool_use parent edge survives. This is safe because rewind's
round-trip validation compares node *kinds* and *parent-index shape*
positionally, never ids. Regression tests assert the origin retains every tool
node across a rewind+ingest, that the two sessions' tool node ids are disjoint,
and that a second exact rewind of the origin is no longer falsely refused. The
demo's rewind-before-restore ordering is retained for readability, but it is no
longer load-bearing.

**FIXED — `sidecar_exists` was reported as a 500.** When the provenance sidecar
moved to being written first, a new `sidecar_exists` refusal code was added, but
`POST /api/nodes/:id/rewind` still only special-cased `transcript_exists` for
409 — so a clean refusal-to-clobber surfaced as a server error and was logged as
a daemon fault. Both collision codes now map to 409.

---

## What this demo does NOT prove

Read this section as carefully as the rest.

- **The T2 advisory critic has never been run against the real Anthropic API
  here.** This run had no `ANTHROPIC_API_KEY`; the only captured T2 output is
  its refusal. Nothing about T2's precision, recall, cost or latency is
  demonstrated.
- **The OpenCode adapter has never been live-verified.** It is covered by unit
  tests against recorded fixtures only. No real `opencode` server was ever
  attached. Treat OpenCode support as untested against a live counterpart.
- **Harvest transfers file *contents* only.** No modes, no exec bits: a
  mode-only change on the branch (`chmod +x` with identical bytes) classifies
  as `identical` and is skipped, and applied files are written with default
  modes, so a script that was executable in the worktree arrives
  non-executable. A branch entry that is itself a symlink is materialized as a
  regular file containing the target **path**. This is stated as a known
  limitation in `harvestEngine.ts`, not as a bug to be fixed.
- **Binary harvest is byte-exact only on the production read path.** Binaries
  land byte-identical when the snapshotter supplies `readFileRaw`, which
  `ShadowSnapshotter` always does — there are explicit byte-comparison tests
  for add, modify, conflict and `allowConflicts`. But the utf8 *fallback* path
  corrupts binary content (invalid byte sequences become U+FFFD before being
  re-encoded), and there is a test that deliberately **pins** that corruption
  as a documented limitation rather than asserting correctness. Production
  never takes that path; if you ever wire a snapshotter without `readFileRaw`,
  it does.
- **No harvest `partial` (exit 2) was produced.** That path needs a mid-apply
  I/O failure; it is covered by unit tests, not by this run.
- **No combine conflict, and no combine `write_failed` (exit 2).** The combine
  pair was deliberately clean, so `--allow-conflicts`, the `conflicts` 400 and
  the `unmarkable` list were never exercised in this run; and `write_failed` —
  the only combine error that leaves a half-built worktree behind — needs a
  mid-write I/O failure that cannot be induced from outside the process. Both
  are covered by unit tests only.
- **Combine's cross-project refusal was not captured.** The demo runs a single
  project, so `cross_project` (two nodes whose trees do not share one shadow
  object database) has no natural shape here and is asserted in unit tests.
- **The web UI was never rendered.** Headless run. Section 16 is written from
  source, not from a browser. The session-filter nudge, the restore-point
  highlighting and the "Restorable" filter are described, not observed.
- **Log rotation's raw-fd survival is inferred, not forced.** Inode stability
  is captured; a post-rotation V8 OOM banner landing in the live file is not.
- **No real Claude Code session was involved anywhere.** Every transcript here
  is synthesized JSONL driven through the hook route. That exercises the
  parser, ingest, snapshotting and flags faithfully — it does not exercise
  Claude Code's actual hook invocation, timing, or payload quirks.
- **One platform, one run.** Captured on darwin with Node 22. The script has
  GNU/BSD shims for `stat`/`md5`, but the transcript above is macOS output and
  Linux has not been verified.
- **`soj gate`'s scope is claims-vs-snapshots, nothing more.** A green gate
  means the daemon found no contradiction between what the assistant said and
  what the snapshot record shows. It is not a code review, not a test run, and
  not a correctness claim about your program.
- **The `~/.claude` isolation check cannot be byte-exact.** It is a live
  directory. The check prints the full diff and fails only on demo-owned
  paths — strong evidence, not a proof.
