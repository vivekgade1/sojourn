# Sojourn — Build Plan **V1**

> **Sojourn** — retrace and rewind your agent's path.
> A cross-CLI decision-graph, state-restore, and **assumption/hallucination-flagging** layer for agentic coding CLIs.
> **v1 scope: Claude Code + OpenCode.** (Gemini deferred — Antigravity-CLI transition risk.)

*CLI command: `soj`. "Agentic" lives in the tagline, not the name.*

**What changed from the draft plan → V1:** added the **Confidence Flags** subsystem (§6) — a two-tier detector that surfaces the assumptions and likely hallucinations the agent makes, built on the deterministic ground-truth Sojourn already has (snapshots, diffs, tool results, repo). Milestones, model, and UI updated to carry it. An honest capability statement is in §6.6 and §13.

---

## 1. The one-paragraph thesis

When you run many sessions and plans across a long coding project, you lose the thread: which decisions were made, what was assumed, and how you got to the current state — and you can't easily tell when the agent **guessed** or **got something wrong**. Native tools give you a **linear** rewind inside **one** CLI session that expires in ~30 days, and none of them tell you where the model made an unstated assumption or a false claim. Sojourn captures **every prompt, tool call, decision, and assumption as a node in a persistent cross-session graph**, **flags the nodes where the agent assumed or likely hallucinated**, lets you **visually navigate** that graph across Claude Code *and* OpenCode, and lets you **check out any node** — restoring both **conversation** and **filesystem** — then **branch** in a new direction. The defensible wedge is the union no shipping product occupies: *cross-CLI + whole-tree (multi-session) restore + decision-aware nodes + branch-and-resume + verifiable confidence flags*.

Table-stakes we do **not** headline: single-CLI rewind, single-CLI conversation forking, read-only transcript viewing.

---

## 2. Design principles

1. **Never be the source of data loss.** Every restore is preceded by an automatic safety snapshot; every snapshot hash is validated before any `checkout`/`read-tree`.
2. **Capture is passive; restore is explicit.** Recording never blocks the agent. Restore is always deliberate and confirmed.
3. **Honest scope on side effects.** We restore *conversation* + *whole-tree file state*. We **cannot** undo Bash side effects (`rm`, `mv`), DB migrations, network calls, `git push`. We warn every time.
4. **Delegate to native primitives; own what they don't.** Conversation restore drives each CLI's own fork/resume/revert. The cross-session graph, whole-tree snapshots, and confidence flags are ours.
5. **The graph is the product.** If a feature doesn't make the cross-session decision *tree* more navigable, restorable, annotatable, or *trustworthy*, it's not v1.
6. **Verifiable over probabilistic.** A flag we can prove from ground truth (the file didn't change; the package doesn't exist) is worth ten guesses from an LLM critic. Deterministic checks ship as confident flags; LLM-based checks ship as clearly-hedged advisories. We would rather miss a soft flag than cry wolf and train users to ignore us.
7. **Local-first, zero-cloud.** Everything runs on `localhost`. No account, no upload.

---

## 3. Architecture overview

External **daemon + per-CLI adapters + local web UI**. The graph model, snapshotter, restore engine, and **flag engine** are CLI-agnostic and live in the core; only *ingestion* and *conversation-restore* are CLI-specific.

```
┌────────────────────────────────────────────────────────────────────────────┐
│                                Sojourn daemon                               │
│                                                                              │
│  ┌───────────────┐   ┌──────────────────┐   ┌──────────────────────┐         │
│  │  Ingestion    │   │  Normalized      │   │  Snapshotter         │         │
│  │  adapters     │──▶│  graph model     │◀─▶│  (shadow git repo    │         │
│  │  - Claude     │   │  (SQLite store)  │   │   per project)       │         │
│  │  - OpenCode   │   └──────────────────┘   └──────────────────────┘         │
│  └───────────────┘            │                        │                     │
│         ▲                     ▼                        ▼                     │
│         │            ┌──────────────────┐   ┌──────────────────────┐         │
│         │            │  Flag engine     │   │  Restore engine      │         │
│         │            │  T1 deterministic│   │  (checkout + branch) │         │
│         │            │  T2 LLM critic   │   └──────────────────────┘         │
│         │            └──────────────────┘             │                      │
│         │                     │                        │                     │
│         │            ┌────────▼─────────┐              │                      │
│         │            │  HTTP + WS API   │──────────────┤                      │
│         │            └──────────────────┘              │                      │
└─────────┼─────────────────────┼─────────────────────────┼───────────────────┘
          │                     │                          │
   ┌──────┴───────┐      ┌──────▼───────┐          ┌──────▼───────┐
   │ CC hooks +   │      │  Web UI      │          │ CC --resume  │
   │ OC plugin/   │      │ (React Flow  │          │ --fork /     │
   │ SSE events   │      │  graph +     │          │ OC revert/   │
   └──────────────┘      │  flag layer) │          │ fork (SDK)   │
                         └──────────────┘          └──────────────┘
```

**Dual capture path per CLI** (belt-and-suspenders): **push** via Claude Code hooks / OpenCode plugin events for timing, **pull** via watching `~/.claude/projects/**/*.jsonl` and polling the OpenCode SSE `/event` stream as the canonical source. The transcript is always ground truth; hooks are just signals.

---

## 4. The normalized graph model

One node type, regardless of CLI — carrying **flags**.

```ts
type NodeKind =
  | "prompt" | "assistant" | "tool_use" | "tool_result"
  | "decision"    // first-class choice point (auto-detected or user-marked)
  | "assumption"  // first-class stated/inferred assumption
  | "fork_point" | "checkpoint";

type FlagTier = "verified" | "advisory";          // T1 deterministic vs T2 LLM
type FlagKind =
  | "edit_claim_mismatch"   // T1 flagship: claimed an edit the snapshot doesn't show
  | "package_hallucination" // T1: imported a package that doesn't exist on the registry
  | "symbol_not_found"      // T1: referenced a symbol/API absent from repo/LSP
  | "file_ref_missing"      // T1: cited a file/path that doesn't exist
  | "test_claim_unverified" // T1: claimed tests pass; no run observed / run failed
  | "unstated_assumption"   // T2: model chose something underspecified
  | "possible_hallucination"; // T2: critic thinks a claim may be false

interface Flag {
  kind: FlagKind;
  tier: FlagTier;
  confidence: "high" | "medium" | "low";
  evidence: string;        // human-readable proof or reasoning
  source: "deterministic" | "llm_critic";
  autoResolved?: boolean;  // T1 flags can clear when a later node fixes them
}

interface ChronoNode {
  id: string; parentId: string | null;
  kind: NodeKind; cli: "claude" | "opencode";
  sessionId: string; projectId: string; timestamp: string;
  snapshotRef: string | null;   // git tree-hash of the WHOLE working dir
  label: string | null; summary: string; content: unknown;
  annotations: Annotation[];
  flags: Flag[];                // ← the confidence-flags surface
  meta: { nativeUuid: string; forkedFrom?: string };
}
```

Key decisions: `parentId` is the tree and we keep **all** children (don't replicate Claude's parallel-tool-call sibling-drop bug, #37779); **cross-CLI nodes share one graph** keyed by repo `projectId`; `snapshotRef` is a **whole-tree** hash; **flags attach to the node they're about** and T1 flags can **auto-resolve** when a later node fixes the issue (so the graph shows "assumed X → later corrected").

---

## 5. Snapshotter, restore engine (core, summarized)

- **Snapshotter:** one **shadow git repo per project** at `~/.sojourn/snapshots/<projectId>/` (never the user's `.git`). Each node boundary → `git add -A && git write-tree` → tree hash; git dedups blobs so unchanged files are free. `.gitignore`-aware overlay excludes `node_modules`, build output, secrets. **Freshness validation before every restore** is non-negotiable.
- **Restore engine:** a node checkout = **safety-snapshot current state → filesystem restore (default: into a new git worktree) → conversation restore via native primitives** (`claude --resume --fork-session`; OpenCode `session.revert`/`fork`). **Live-agent caveat:** we launch a freshly forked/resumed session at the node, not mutate a running process. Every restore shows a pre-flight panel naming what will and will **not** be undone.

---

## 6. Confidence Flags — assumption & hallucination detection

The feature that tells the user where the agent **guessed** or **likely got it wrong**, built to be *trustworthy first*. Two tiers with deliberately different promises.

### 6.1 Why Sojourn is the right place for this
The detector already has, per node, everything expensive to reconstruct elsewhere: the **full transcript**, the **tool calls and their real results**, the **actual filesystem diff** (from the two surrounding tree hashes), and the **repository**. That means the highest-value checks are pure ground-truth comparisons, not model guesswork.

### 6.2 Tier 1 — deterministic checks (ship as **verified**, high-confidence flags)
Cheap, local, high-precision, explainable. The trustworthy core and the reason the feature is worth shipping.

- **Edit-claim verification — the flagship.** The agent says "I updated `auth.py` to handle refresh tokens." Sojourn compares the claim to the **actual diff** between the node's snapshot and its parent. If the file didn't change (or changed somewhere else), that's a **high-confidence `edit_claim_mismatch`** — provably true, immediately useful, and unique to a tool that holds the snapshots. This alone justifies the subsystem.
- **Package-hallucination / slopsquatting check.** Every newly-imported dependency is checked against the real registry (npm/PyPI). Non-existent packages → `package_hallucination`. (Package hallucination is common enough — ~1-in-5 in some studies — and dangerous enough, via slopsquatting, that this is a security feature, not just a correctness one.)
- **Symbol / API existence.** Referenced functions, methods, and imports are checked against the repo via **LSP / AST / type-checker**. Absent symbols → `symbol_not_found`.
- **File/path reference grounding.** Cited files, configs, and paths are checked against the actual tree. Missing → `file_ref_missing`.
- **Test/build-claim verification.** "Tests pass" with no observed test run in the tool results, or a run that actually failed → `test_claim_unverified`.

All T1 flags carry their **evidence** ("claimed edit to `auth.py`; snapshot diff shows no change to that file") and can **auto-resolve** when a later node fixes them.

### 6.3 Tier 2 — LLM critic (ship as **advisory**, clearly-hedged low/medium flags)
Optional, opt-in, token-costing second pass that re-reads a node and flags what deterministic checks can't see:

- **Unstated assumptions** — the model chose a database, an API shape, a config default, a library version, or a project structure without being told. These are *not* errors; they're decisions the user should get to see and confirm. Presented as neutral "**Assumed:** …", never as failures.
- **Possible hallucinations** — claims the critic thinks may be false but nothing deterministic can confirm.

T2 is framed honestly as *advisory*: "possible," "worth checking," never a confident verdict. Off by default; runs per-node on demand or in a batch pass.

### 6.4 What we deliberately do **not** do
- No token-logprob / perplexity or semantic-entropy signals for **Claude Code** — the Claude API doesn't expose logprobs, so those techniques aren't available there; we don't pretend otherwise. (If an OpenCode-routed model exposes logprobs, that's a possible later enhancement, not a v1 promise.)
- No claim that T2 "catches hallucinations." Detecting hallucination is at least as hard as the original task; the critic is a helper, not an oracle.

### 6.5 Presentation — earning trust, avoiding alert fatigue
- **Two visually distinct classes.** **Verified** flags (T1) get a solid, confident treatment; **advisory** flags (T2) get a muted, clearly-tentative treatment. Users must never confuse "proven" with "maybe."
- **Flag density is a feature, not noise.** The graph shows a small badge on flagged nodes; counts roll up so you can spot "the run where things went sideways" at a glance. The **decision lens** (see §7) can filter to *only flagged nodes*.
- **Default to quiet.** T1 on by default (cheap and trustworthy); T2 off by default. A global sensitivity control. Dismiss/acknowledge per flag, and dismissals are remembered.
- **Every flag is inspectable and actionable.** Click → see evidence → optionally **jump to restore** at the node just before the assumption/error, tying the feature straight back into Sojourn's core loop: *spot the bad assumption → rewind to before it → branch correctly.*

### 6.6 Honest capability statement (put this in the README too)
> Sojourn's **verified** flags are deterministic ground-truth checks — when they fire, they're almost always right, because they compare the agent's claims to what actually happened on disk and in the registries. The flagship "you said you edited X but you didn't" check is both reliable and genuinely useful. Sojourn's **advisory** flags (unstated assumptions, possible hallucinations) come from an optional LLM pass; they surface things worth a look but are **not** authoritative, will sometimes be wrong in both directions, and are labeled as advisory for that reason. Sojourn will **not** catch every hallucination, and a clean node is **not** a guarantee of correctness. The feature is a high-signal assistant for reviewing agent work, not a correctness proof.

---

## 7. Visualization (UI)

- **Local web UI** served by the daemon; **React Flow** node graph, custom node types per `kind`, color by `cli`, diverging edges for branches, "you are here" marker, collapse/expand of tool/subagent subtrees.
- **Flag layer:** verified vs advisory badges (§6.5), rollup counts, click-through evidence, "restore to just before this" action.
- **Node inspector:** message/tool payload, on-demand file diff (from the two tree hashes), annotations, and this node's flags.
- **Decision lens:** collapse the graph to `decision`/`assumption`/`checkpoint` **and/or flagged** nodes — the one-screen "how did we get here, and where did it guess?" view.
- **Minimal terminal entry points:** `soj open`, `soj mark`, `soj checkpoint <name>`, `soj flags` (list this session's flags). In-CLI slash equivalents where each CLI supports them.

---

## 8. Repo layout (monorepo)

```
sojourn/
├─ packages/
│  ├─ core/                 # graph model, SQLite store, snapshotter, restore engine, FLAG ENGINE
│  │  ├─ src/graph/
│  │  ├─ src/snapshot/
│  │  ├─ src/restore/
│  │  ├─ src/flags/         # ← tier-1 deterministic checks + tier-2 critic orchestration
│  │  │   ├─ editClaim.ts
│  │  │   ├─ packages.ts
│  │  │   ├─ symbols.ts
│  │  │   ├─ fileRefs.ts
│  │  │   ├─ tests.ts
│  │  │   └─ critic.ts
│  │  └─ src/store/
│  ├─ daemon/              # HTTP + WS server, file watchers, SSE pollers, orchestration
│  ├─ adapter-claude/      # JSONL parser, hook scripts, --resume/--fork driver
│  ├─ adapter-opencode/    # SDK client, plugin, event subscription, revert/fork driver
│  ├─ web/                 # React Flow UI + flag layer
│  └─ cli/                 # `soj` command
├─ plugins/
│  ├─ claude/              # .claude-plugin/ manifest + hooks/
│  └─ opencode/            # .opencode/plugins/ entry
├─ BUILD_PLAN.md
└─ README.md
```

**Stack:** TypeScript throughout; Node daemon; SQLite (better-sqlite3); system `git` behind an interface (swap to `isomorphic-git` if needed); React + React Flow + Vite; `chokidar` for watching. Flag engine leans on existing LSP/type-checkers and registry lookups; T2 critic calls whatever model the user already uses.

---

## 9. Milestone plan (week-by-week)

Each milestone is independently useful; we prove *capture* before *restore*, *one CLI* before *two*, and *deterministic flags* before *the critic*.

### Milestone 0 — Spike & de-risk (Week 1)
- Spike A: parse a real Claude `.jsonl`, reconstruct the `parentUuid` tree (incl. parallel-tool-call siblings), render it.
- Spike B: OpenCode server locally — subscribe to `/event` SSE, call `session.revert` + `session.fork` via SDK on a throwaway session.
- Spike C: shadow-git snapshot → `write-tree` → mutate → restore into a worktree → verify byte-identical + freshness validation.
- Spike D: **edit-claim proof-of-concept** — from a transcript node's assistant text, extract "I edited `<file>`" claims and diff against the surrounding snapshots; confirm we can produce a correct `edit_claim_mismatch`.
- **Exit:** all four work as throwaway scripts. If B, C, or D fails, the plan changes here (cheap).

### Milestone 1 — Passive capture, Claude Code, read-only graph (Weeks 2–3)
- Daemon + SQLite + normalized model (with `flags` field present but unpopulated).
- Claude adapter: file watcher (pull) + `SessionStart`/`PostToolUse` hook (push).
- Snapshotter wired to node boundaries (capture only).
- Web UI: cross-session tree, click-to-inspect, on-demand diffs.
- **Exit:** run a multi-prompt Claude session; every prompt/tool-call is a node with correct parentage and a working per-node diff.

### Milestone 2 — Tier-1 confidence flags (Weeks 4–5)
- Flag engine T1: **edit-claim verification (flagship)** first, then package-existence, symbol/file-ref grounding, test-claim checks.
- UI flag layer: verified badges, evidence panel, rollup counts, decision-lens flag filter.
- Auto-resolve logic when a later node fixes a flagged issue.
- **Exit (benchmark):** in a session where the agent claims an edit it didn't make and imports a non-existent package, both nodes are flagged with correct evidence, and a genuinely-correct session shows **zero** false flags on a held-out sample.

### Milestone 3 — Restore + branch, Claude Code (Weeks 6–7)
- Restore engine: safety-snapshot → filesystem restore into a worktree → `claude --resume --fork-session` at the node.
- Pre-flight side-effects panel; freshness validation on every path.
- Wire flags → restore: "restore to just before this flagged node."
- **Exit (benchmark):** rewind to a node from a 3-day-old session into a fresh worktree and resume with correct conversation + files; original untouched.

### Milestone 4 — OpenCode adapter → cross-CLI unification (Weeks 8–10)
- OpenCode adapter: SDK client + plugin events (push) + storage parse (pull); conversation restore via `session.revert`/`fork`.
- T1 flags run on OpenCode nodes too (same engine).
- **Unify by `projectId`:** one repo across both CLIs → one tree with mixed `cli` nodes and flags.
- **Exit (benchmark):** work one repo in both CLIs; see a single unified, flagged decision graph; check out a Claude node and an OpenCode node from the same tree.

### Milestone 5 — Tier-2 LLM critic + decision-aware nodes (Weeks 11–12)
- `soj mark` and `soj checkpoint <name>`; auto-detected decision points.
- T2 critic: opt-in, advisory **unstated-assumption** and **possible-hallucination** flags, visually distinct and hedged (§6.5).
- **Exit:** the collapsed decision+flag view answers "how did we get here, and where did it assume/guess?" on one screen for a real multi-session project — with T1 and T2 clearly distinguished.

### Milestone 6 — Hardening & the return path (Weeks 13+)
- Merge/return-path UX (bring a branch's conclusions back — the gap in Anthropic #32631).
- Retention/GC, `.gitignore` overlay tuning, secrets exclusion, flag-dismissal memory.
- Packaging: `npx sojourn` / `soj`, plugin install flows for both CLIs.

---

## 10. Risks & triggers

| Risk | Likelihood | If it happens |
|---|---|---|
| **Anthropic ships #32631** (native tree nav + restore) | Med-High | Pivot hard to cross-CLI + whole-tree restore + **confidence flags** + decision nodes; drop single-CLI framing. M4–M6 are exactly what native branching won't cover. |
| **A fast-follower ships rewind/fork + a 2nd CLI** | Low-Med | If Apache-2.0, evaluate contributing/forking its object store rather than rebuilding. |
| **OpenCode revert/snapshot internals keep changing** | Med | We delegate to its SDK (not disk format) and gate restores behind freshness validation. |
| **T2 critic false positives erode trust** | Med-High | Keep T2 off by default, always hedged and visually separate; never let advisory look verified. Trust lives in T1. |
| **T1 edit-claim parsing misfires on informal phrasing** | Med | Start conservative (flag only clear claims), tune precision over recall, always show evidence so users can judge. |
| **Can't capture Bash side effects** | High (universal) | Scoped out honestly; whole-tree snapshots still recover *files* touched by Bash. |
| **Capture/flag overhead annoys users** | Low | Capture async; snapshots git-cheap; T1 checks cheap; T2 opt-in. Hard overhead ceiling benchmarked in M1–M2. |

---

## 11. What "done with V1" means

A developer can:
1. Install Sojourn as a plugin for **both** Claude Code and OpenCode.
2. Work across **multiple sessions and both CLIs** on one repo and see a **single navigable decision graph**.
3. See **verified flags** where the agent claimed an edit it didn't make, imported a non-existent package, referenced a missing symbol/file, or claimed unverified tests — each with evidence — and **advisory flags** (opt-in) for unstated assumptions and possible hallucinations, clearly marked as advisory.
4. Click **any node** — days old or from the other CLI — and **check out** its conversation + filesystem into a fresh worktree, then **resume**; including "restore to just before this flagged node."
5. **Mark decisions/assumptions** and view the collapsed "how we got here, and where it guessed" path.
6. Trust that **no action ever silently loses their work** (safety snapshots + freshness validation + explicit side-effect warnings), and that **verified flags mean what they say** while advisory flags are honestly labeled.

That bundle — cross-CLI, whole-tree restore, decision-aware, branch-and-resume, **with a verifiable confidence-flag layer** — is the wedge nothing on the market occupies.

---

## 12. Immediate next actions

1. **Confirm the name** (Sojourn) and **check availability** (npm `sojourn`/`soj`, GitHub org, domain) before committing — "sojourn" is a common word and will collide, so a quick five-minute check now saves a rename later.
2. Create the monorepo skeleton (§8).
3. **Milestone 0, Spikes A + D** — the Claude JSONL→tree parse and the **edit-claim proof-of-concept**. A is the backbone; D de-risks the flagship flag and is the cheapest way to prove the flagging feature has teeth.
4. Settle the one open tech choice: **system `git` vs `isomorphic-git`** for the snapshotter (recommendation: system `git` in v1, behind an interface).

---

## 13. The honest bottom line on the flagging feature

The deterministic tier is the real prize: because Sojourn holds the snapshots, the tool results, and the repo, checks like *"you said you changed this file and you didn't"* and *"this package doesn't exist"* are **provable, high-precision, and genuinely useful** — and no session viewer or native CLI feature currently surfaces them. That is a strong, defensible feature. The LLM-critic tier is a **useful-but-fallible helper**: it will surface real assumptions and some real errors, and it will also be wrong sometimes in both directions, so we ship it opt-in, hedged, and visually separate. We tell users plainly (§6.6) that verified flags are trustworthy, advisory flags are leads to check, and a clean node is not a proof of correctness. Built this way, the feature strengthens the core loop instead of overpromising: **spot where the agent guessed or slipped → rewind to just before it → branch correctly.**
