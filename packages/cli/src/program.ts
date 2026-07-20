import { Command } from "commander";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sojournHome, projectIdFor, GraphStore, gcShadowRepo, collectPins } from "@sojourn/core";
import type {
  Project,
  SessionRow,
  ChronoNode,
  StoredFlag,
  RestorePreflight,
  RestoreResult,
  HarvestPreflight,
  HarvestResult,
  CombinePreflight,
  CombineResult,
  SearchHit,
  SessionHealth,
} from "@sojourn/core";
import { claudeProjectsDir, listRewindSidecars } from "@sojourn/adapter-claude";
import { DaemonClient, encodeNodeId } from "./client.js";
import { activeFlags, excerpt, filterDecisionHits, gistOf } from "./searchFormat.js";
import {
  resolveDaemonEntry,
  readPid,
  writePid,
  removePidfile,
  isPidAlive,
  killPid,
  pollHealth,
  isDaemonProcess,
  daemonLogPath,
  tailLogLines,
  type PsCommandFn,
} from "./daemonCtl.js";

export interface SpawnedProcess {
  pid: number | undefined;
  unref(): void;
}

export interface ProgramDeps {
  /** e.g. http://localhost:4177 */
  baseUrl: string;
  /** $SOJOURN_HOME, defaults to core's sojournHome() */
  sojournHome: string;
  /** cwd used to resolve "current project" */
  cwd: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** spawns the daemon process; injectable for tests */
  spawnDaemon: (entry: string, env: NodeJS.ProcessEnv) => SpawnedProcess;
  /** opens a URL in the platform browser; injectable for tests */
  openUrl: (url: string) => void;
  /** fetch used only for health polling (defaults to global fetch via DaemonClient-compatible shape) */
  fetchJson: (url: string) => Promise<{ status: number; body: unknown }>;
  /** process.exit-like hook, injectable so tests can capture exit codes without killing the process */
  exit: (code: number) => void;
  /** how long `soj start` polls /api/health before giving up (default ~5s) */
  healthTimeoutMs: number;
  /** poll interval for the health check (default 200ms) */
  healthIntervalMs: number;
  /** ps command lookup used to verify a pid is actually the daemon; injectable for tests */
  psCommand?: PsCommandFn;
}

export function defaultDeps(overrides: Partial<ProgramDeps> = {}): ProgramDeps {
  const baseUrl = overrides.baseUrl ?? `http://localhost:${process.env.SOJOURN_PORT ?? "4177"}`;
  const home = overrides.sojournHome ?? sojournHome();
  return {
    baseUrl,
    sojournHome: home,
    cwd: overrides.cwd ?? process.cwd(),
    stdout: overrides.stdout ?? ((line) => process.stdout.write(line + "\n")),
    stderr: overrides.stderr ?? ((line) => process.stderr.write(line + "\n")),
    spawnDaemon:
      overrides.spawnDaemon ??
      ((entry, env) => {
        // Pipe the child's stdout+stderr into $SOJOURN_HOME/daemon.log
        // (append): output from a crash BEFORE the daemon's own logger
        // initializes (bad require, syntax error, native module failure)
        // must land somewhere readable, never a discarded pipe.
        // SOJOURN_DAEMON_DETACHED tells the daemon's logger to skip console
        // mirroring — its stdout already IS daemon.log here, and mirroring
        // would double every line.
        let stdio: "ignore" | Array<"ignore" | number> = "ignore";
        let fd: number | null = null;
        try {
          fs.mkdirSync(home, { recursive: true });
          fd = fs.openSync(daemonLogPath(home), "a");
          stdio = ["ignore", fd, fd];
        } catch {
          // unwritable home: fall back to the old discard behavior rather
          // than failing the start
        }
        const child = spawn(process.execPath, [entry], {
          detached: true,
          stdio,
          env: { ...env, SOJOURN_DAEMON_DETACHED: "1" },
        });
        child.unref();
        if (fd !== null) {
          try {
            fs.closeSync(fd); // child holds its own copy of the fd
          } catch {
            // already closed — nothing to do
          }
        }
        return { pid: child.pid, unref: () => child.unref() };
      }),
    openUrl:
      overrides.openUrl ??
      ((url) => {
        const platform = process.platform;
        const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
        try {
          const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
          child.unref();
        } catch {
          // headless / no opener available - swallow, caller already printed the URL
        }
      }),
    fetchJson:
      overrides.fetchJson ??
      (async (url) => {
        const res = await fetch(url);
        const text = await res.text();
        let body: unknown;
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          body = text;
        }
        return { status: res.status, body };
      }),
    exit: overrides.exit ?? ((code) => process.exit(code)),
    healthTimeoutMs: overrides.healthTimeoutMs ?? 5000,
    healthIntervalMs: overrides.healthIntervalMs ?? 200,
    psCommand: overrides.psCommand,
  };
}

export function buildProgram(deps: ProgramDeps): Command {
  const client = new DaemonClient(deps.baseUrl);
  const program = new Command();
  program.name("soj").description("Sojourn CLI").exitOverride();

  program
    .command("start")
    .description("start the sojourn daemon")
    .action(async () => {
      const existingPid = readPid(deps.sojournHome);
      if (existingPid !== null && isPidAlive(existingPid)) {
        const isDaemon = await isDaemonProcess(existingPid, { psCommand: deps.psCommand });
        if (isDaemon) {
          deps.stdout(`daemon already running (pid ${existingPid})`);
          return;
        }
        deps.stdout(
          `pidfile referenced pid ${existingPid}, which is not a sojourn daemon (stale pidfile) — removing and starting fresh`,
        );
        removePidfile(deps.sojournHome);
      }
      const entry = resolveDaemonEntry();
      const child = deps.spawnDaemon(entry, { ...process.env });
      if (child.pid === undefined) {
        deps.stderr("failed to spawn daemon: no pid");
        deps.exit(1);
        return;
      }
      writePid(deps.sojournHome, child.pid);
      child.unref();
      const healthy = await pollHealth({
        baseUrl: deps.baseUrl,
        fetchJson: deps.fetchJson,
        timeoutMs: deps.healthTimeoutMs,
        intervalMs: deps.healthIntervalMs,
      });
      if (!healthy) {
        deps.stderr(`daemon did not become healthy within timeout (pid ${child.pid})`);
        const tail = tailLogLines(deps.sojournHome, 10);
        if (tail.length > 0) {
          deps.stderr("last daemon.log lines:");
          for (const line of tail) deps.stderr(`  ${line}`);
        }
        deps.stderr(`see ${daemonLogPath(deps.sojournHome)}`);
        deps.exit(1);
        return;
      }
      deps.stdout(`daemon started (pid ${child.pid}) at ${deps.baseUrl}`);
    });

  program
    .command("stop")
    .description("stop the sojourn daemon")
    .action(async () => {
      const pid = readPid(deps.sojournHome);
      if (pid === null) {
        deps.stdout("daemon is not running (no pidfile)");
        return;
      }
      if (isPidAlive(pid)) {
        const isDaemon = await isDaemonProcess(pid, { psCommand: deps.psCommand });
        if (!isDaemon) {
          removePidfile(deps.sojournHome);
          deps.stdout(
            `pidfile referenced pid ${pid}, which is not a sojourn daemon (stale pidfile) — removed, not signaling it`,
          );
          return;
        }
      }
      const sent = killPid(pid, "SIGTERM");
      removePidfile(deps.sojournHome);
      if (sent) {
        deps.stdout(`daemon stopped (pid ${pid})`);
      } else {
        deps.stdout(`daemon was not running (stale pidfile for pid ${pid} removed)`);
      }
    });

  program
    .command("status")
    .description("show daemon status")
    .action(async () => {
      const pid = readPid(deps.sojournHome);
      if (pid === null) {
        deps.stdout("daemon: stopped");
        return;
      }
      if (!isPidAlive(pid)) {
        // Pidfile exists but its process is gone: the daemon crashed or was
        // killed out-of-band. Surface the evidence right here.
        deps.stdout(`daemon: stopped (pidfile pid ${pid} is dead — crashed or killed)`);
        const tail = tailLogLines(deps.sojournHome, 5);
        if (tail.length > 0) {
          deps.stdout("last daemon.log lines:");
          for (const line of tail) deps.stdout(`  ${line}`);
        }
        deps.stdout(`see ${daemonLogPath(deps.sojournHome)}`);
        return;
      }
      const res = await deps.fetchJson(`${deps.baseUrl.replace(/\/$/, "")}/api/health`).catch(
        () => null,
      );
      if (res && res.status === 200 && (res.body as { ok?: boolean } | undefined)?.ok) {
        const version = (res.body as { version?: string }).version ?? "unknown";
        deps.stdout(`daemon: running (pid ${pid}, version ${version}) at ${deps.baseUrl}`);
      } else {
        deps.stdout(`daemon: pid ${pid} alive but not responding at ${deps.baseUrl}`);
      }
    });

  program
    .command("open")
    .description("open the sojourn web UI")
    .action(() => {
      deps.stdout(deps.baseUrl);
      try {
        deps.openUrl(deps.baseUrl);
      } catch {
        // headless environments / missing opener must not fail this command
      }
    });

  program
    .command("projects")
    .description("list known projects")
    .action(
      withDaemonErrorHandling(deps, async () => {
        const res = await client.get<Project[]>("/api/projects");
        if (res.status !== 200) {
          deps.stderr(`error: ${describeError(res.body)}`);
          deps.exit(1);
          return;
        }
        deps.stdout(formatProjectsTable(res.body));
      }),
    );

  program
    .command("flags")
    .description("list active flags for a project")
    .option("--project <id>", "project id (default: project for cwd)")
    .option("--all", "include auto-resolved flags (annotated)", false)
    .action(
      withDaemonErrorHandling(deps, async (opts: { project?: string; all: boolean }) => {
        const projectId = opts.project ?? projectIdFor(deps.cwd);
        const res = await client.get<{ project: Project; sessions: SessionRow[]; nodes: ChronoNode[] }>(
          `/api/projects/${encodeNodeId(projectId)}/graph`,
        );
        if (res.status !== 200) {
          deps.stderr(`error: ${describeError(res.body)}`);
          deps.exit(1);
          return;
        }
        const flags: Array<StoredFlag & { nodeId: string }> = [];
        for (const node of res.body.nodes) {
          for (const flag of node.flags ?? []) {
            if (flag.dismissed) continue;
            // Auto-resolved flags are settled history — hidden by default,
            // shown (annotated) only with --all.
            if (flag.autoResolved && !opts.all) continue;
            flags.push({ ...flag, nodeId: node.id });
          }
        }
        deps.stdout(formatFlagsTable(flags));
      }),
    );

  program
    .command("critic <nodeId>")
    .description("run the Tier-2 advisory critic on a node (requires ANTHROPIC_API_KEY on the daemon)")
    .action(
      withDaemonErrorHandling(deps, async (nodeId: string) => {
        const res = await client.post<{ flags: StoredFlag[] }>(
          `/api/nodes/${encodeNodeId(nodeId)}/flags/run`,
          { tier: "T2" },
        );
        if (res.status !== 200) {
          deps.stderr(`error: ${describeError(res.body)}`);
          deps.exit(1);
          return;
        }
        const advisory = (res.body.flags ?? []).filter(
          (f) => f.tier === "advisory" && !f.dismissed,
        );
        if (advisory.length === 0) {
          deps.stdout("no advisory flags.");
          return;
        }
        deps.stdout(
          formatFlagsTable(advisory.map((f) => ({ ...f, nodeId: f.nodeId ?? nodeId }))),
        );
      }),
    );

  program
    .command("mark <label>")
    .description("mark the latest node with a label")
    .option("--kind <kind>", "decision|assumption|checkpoint", "decision")
    .option("--session <id>", "session id (default: latest session in cwd's project)")
    .action(
      withDaemonErrorHandling(deps, async (label: string, opts: { kind: string; session?: string }) => {
        const sessionId = opts.session ?? (await resolveLatestSessionId(client, deps));
        if (!sessionId) {
          deps.stderr("error: no session found for current project (pass --session)");
          deps.exit(1);
          return;
        }
        const res = await client.post<ChronoNode>("/api/mark", {
          sessionId,
          label,
          kind: opts.kind,
        });
        if (res.status !== 200 && res.status !== 201) {
          deps.stderr(`error: ${describeError(res.body)}`);
          deps.exit(1);
          return;
        }
        deps.stdout(`marked ${res.body.id} [${res.body.kind}] "${res.body.label ?? label}"`);
      }),
    );

  program
    .command("checkpoint <name>")
    .description("shorthand for mark --kind checkpoint")
    .option("--session <id>", "session id (default: latest session in cwd's project)")
    .action(
      withDaemonErrorHandling(deps, async (name: string, opts: { session?: string }) => {
        const sessionId = opts.session ?? (await resolveLatestSessionId(client, deps));
        if (!sessionId) {
          deps.stderr("error: no session found for current project (pass --session)");
          deps.exit(1);
          return;
        }
        const res = await client.post<ChronoNode>("/api/mark", {
          sessionId,
          label: name,
          kind: "checkpoint",
        });
        if (res.status !== 200 && res.status !== 201) {
          deps.stderr(`error: ${describeError(res.body)}`);
          deps.exit(1);
          return;
        }
        deps.stdout(`marked ${res.body.id} [checkpoint] "${res.body.label ?? name}"`);
      }),
    );

  program
    .command("restore <nodeId>")
    .description("restore a node's snapshot into a worktree")
    .option("--yes", "skip preflight confirmation and perform the restore", false)
    .action(
      withDaemonErrorHandling(deps, async (nodeId: string, opts: { yes: boolean }) => {
        const encoded = encodeNodeId(nodeId);
        if (!opts.yes) {
          const res = await client.post<RestorePreflight>(`/api/nodes/${encoded}/preflight`);
          if (res.status !== 200) {
            deps.stderr(`error: ${describeError(res.body)}`);
            deps.exit(1);
            return;
          }
          const preflight = res.body;
          if (preflight.warnings.length > 0) {
            deps.stdout("Preflight warnings:");
            for (const warning of preflight.warnings) {
              deps.stdout(`  - ${warning}`);
            }
          } else {
            deps.stdout("Preflight: no warnings.");
          }
          if (preflight.resumeCommand) {
            deps.stdout(`Resume command: ${preflight.resumeCommand}`);
          }
          deps.stdout("Re-run with --yes to confirm the restore.");
          deps.exit(1);
          return;
        }
        const res = await client.post<RestoreResult>(`/api/nodes/${encoded}/restore`);
        if (res.status !== 200) {
          deps.stderr(`error: ${describeError(res.body)}`);
          deps.exit(1);
          return;
        }
        const result = res.body;
        deps.stdout(`Worktree: ${result.worktreePath}`);
        if (result.resumeCommand) {
          deps.stdout(`Resume command: ${result.resumeCommand}`);
        }
        for (const warning of result.warnings) {
          deps.stdout(`Warning: ${warning}`);
        }
      }),
    );

  program
    .command("harvest [worktreePath]")
    .description(
      "carry a restored worktree's changes back to the mainline (dry preflight by default). " +
        "Run it from inside the restored worktree, or pass its path.",
    )
    .option("--yes", "skip the preflight and perform the harvest", false)
    .option("--mode <mode>", "apply|patch — write files directly, or emit a patch file", "apply")
    .option(
      "--allow-conflicts",
      "write conflict markers into conflicting files instead of aborting (apply mode only)",
      false,
    )
    .action(
      withDaemonErrorHandling(
        deps,
        async (
          worktreeArg: string | undefined,
          opts: { yes: boolean; mode: string; allowConflicts: boolean },
        ) => {
          if (opts.mode !== "apply" && opts.mode !== "patch") {
            deps.stderr(`error: --mode must be one of apply|patch (got "${opts.mode}")`);
            deps.exit(1);
            return;
          }
          // The daemon SILENTLY ignores allowConflicts in patch mode
          // (harvestEngine.ts). Refusing here is the honest surface: a flag
          // that looks accepted but does nothing is a lie to the user.
          if (opts.allowConflicts && opts.mode === "patch") {
            deps.stderr(
              "error: --allow-conflicts applies to --mode apply only (a patch never writes conflict markers into the mainline).",
            );
            deps.exit(1);
            return;
          }
          // Resolve BEFORE sending: the daemon reads .sojourn-restore.json
          // from this literal path, so a relative path would break it.
          const worktreePath = path.resolve(deps.cwd, worktreeArg ?? ".");

          if (!opts.yes) {
            const res = await client.post<HarvestPreflight>(
              "/api/worktrees/harvest/preflight",
              { worktreePath },
            );
            if (res.status !== 200) {
              reportHarvestError(deps, res.status, res.body);
              return;
            }
            const preflight = res.body;
            deps.stdout(`Worktree: ${preflight.worktreePath}`);
            deps.stdout(`Origin node: ${preflight.originNodeId}`);
            // `mainlineDirty` means the MAINLINE MOVED on a path this harvest
            // touches — NOT "your whole tree is dirty". Label it honestly.
            deps.stdout(
              preflight.mainlineDirty
                ? "Mainline: dirty (moved on a path this harvest touches)"
                : "Mainline: clean (unchanged on the paths this harvest touches)",
            );
            const files = [...preflight.files].sort(
              (a, b) => harvestStatusRank(a.status) - harvestStatusRank(b.status),
            );
            if (files.length > 0) {
              deps.stdout(renderTable(["status", "file"], files.map((f) => [f.status, f.path])));
            }
            const counts = { clean: 0, conflict: 0, identical: 0 };
            for (const f of preflight.files) counts[f.status]++;
            deps.stdout(
              `${counts.clean} clean, ${counts.conflict} conflict, ${counts.identical} identical`,
            );
            if (preflight.warnings.length > 0) {
              deps.stdout("Preflight warnings:");
              for (const warning of preflight.warnings) deps.stdout(`  - ${warning}`);
            }
            deps.stdout("Re-run with --yes to confirm the harvest.");
            deps.exit(1);
            return;
          }

          const res = await client.post<HarvestResult & { warnings: string[] }>(
            "/api/worktrees/harvest",
            {
              worktreePath,
              mode: opts.mode,
              // The daemon tests `body.allowConflicts === true` — must be a
              // real boolean, never a string.
              allowConflicts: opts.allowConflicts === true,
            },
          );
          if (res.status !== 200) {
            reportHarvestError(deps, res.status, res.body);
            return;
          }
          const result = res.body;
          // Patch mode NEVER populates applied/conflicted/skippedIdentical —
          // printing "0 files applied" for a successful patch run is wrong.
          if (result.patchPath !== null) {
            deps.stdout(`Patch: ${result.patchPath}`);
            deps.stdout(`Safety snapshot: ${result.safetySnapshotRef}`);
          } else {
            deps.stdout(`Applied (${result.applied.length}):`);
            for (const file of result.applied) deps.stdout(`  ${file}`);
            if (result.conflicted.length > 0) {
              deps.stdout(`Conflicted (${result.conflicted.length}):`);
              for (const file of result.conflicted) deps.stdout(`  ${file}`);
            }
            deps.stdout(`Skipped (identical, ${result.skippedIdentical.length})`);
            deps.stdout(`Safety snapshot: ${result.safetySnapshotRef}`);
          }
          if (result.mergeNodeId !== null) {
            deps.stdout(`Merge node: ${result.mergeNodeId}`);
          }
          for (const warning of result.warnings ?? []) {
            deps.stdout(`Warning: ${warning}`);
          }
        },
      ),
    );

  program
    .command("combine <nodeIdA> <nodeIdB>")
    .description(
      "merge the FILE STATES of two nodes (usually from different sessions) into one new " +
        "worktree, recording both ancestors (dry preflight by default). " +
        "NO TRANSCRIPT IS SYNTHESIZED — combine emits files only; start a fresh session " +
        "in the resulting worktree.",
    )
    .option("--yes", "skip the preflight and perform the combine", false)
    .option(
      "--allow-conflicts",
      "write conflict markers into conflicting files instead of aborting",
      false,
    )
    .action(
      withDaemonErrorHandling(
        deps,
        async (
          nodeIdA: string,
          nodeIdB: string,
          opts: { yes: boolean; allowConflicts: boolean },
        ) => {
          // Cheap local guard so the obvious mistake costs zero round-trips.
          // (The daemon rejects it too, with the same 400.)
          if (nodeIdA === nodeIdB) {
            deps.stderr(
              `error: cannot combine a node with itself — nodeIdA and nodeIdB are both ${nodeIdA}`,
            );
            deps.exit(1);
            return;
          }

          // Ids travel in the BODY of a STATIC path — there is no `:id`
          // segment here, so encodeNodeId must NOT be applied.
          if (!opts.yes) {
            // combinePreflight is genuinely pure: it snapshots nothing and
            // writes nothing, in the project or the shadow repo.
            const res = await client.post<CombinePreflight>("/api/nodes/combine/preflight", {
              nodeIdA,
              nodeIdB,
            });
            if (res.status !== 200) {
              reportCombineError(deps, res.body);
              return;
            }
            const preflight = res.body;
            deps.stdout(`Node A: ${preflight.nodeIdA}`);
            deps.stdout(`Node B: ${preflight.nodeIdB}`);
            deps.stdout(`Merge base: ${preflight.baseNodeId}`);
            deps.stdout(`Trees: base ${preflight.baseTree} | A ${preflight.treeA} | B ${preflight.treeB}`);
            const files = [...preflight.files].sort(
              (a, b) => harvestStatusRank(a.status) - harvestStatusRank(b.status),
            );
            if (files.length > 0) {
              deps.stdout(
                renderTable(
                  ["status", "file"],
                  files.map((f) => [
                    // An unmarkable conflict can never take conflict markers —
                    // even under --allow-conflicts A's content is kept as-is.
                    // Labelling it "conflict" alone would overpromise.
                    f.unmarkable === true ? `${f.status} (unmarkable)` : f.status,
                    f.path,
                  ]),
                ),
              );
            }
            const counts = { clean: 0, conflict: 0, identical: 0 };
            for (const f of preflight.files) counts[f.status]++;
            deps.stdout(
              `${counts.clean} clean, ${counts.conflict} conflict, ${counts.identical} identical`,
            );
            // `warnings` is never empty — it always carries the
            // "no transcript is synthesized" notice. Echo it verbatim.
            if (preflight.warnings.length > 0) {
              deps.stdout("Preflight warnings:");
              for (const warning of preflight.warnings) deps.stdout(`  - ${warning}`);
            }
            deps.stdout("Re-run with --yes to confirm the combine.");
            deps.exit(1);
            return;
          }

          const res = await client.post<CombineResult>("/api/nodes/combine", {
            nodeIdA,
            nodeIdB,
            // The daemon tests `body.allowConflicts === true` — must be a
            // real boolean, never a string.
            allowConflicts: opts.allowConflicts === true,
          });
          if (res.status !== 200) {
            reportCombineError(deps, res.body);
            return;
          }
          const result = res.body;
          // The worktree IS the product of a combine — lead with it.
          deps.stdout(`Worktree: ${result.worktreePath}`);
          deps.stdout(`Merge base: ${result.baseNodeId}`);
          deps.stdout(`Applied (${result.applied.length}):`);
          for (const file of result.applied) deps.stdout(`  ${file}`);
          // `unmarkable` is a SUBSET of `conflicted` (the engine pushes those
          // paths into both — conflicted means "conflicted", not "marked").
          // Subtract before printing, or a binary conflict would be listed
          // twice, the first time under a label that is false for it: nothing
          // was marked in that file, A's content was kept verbatim.
          const unmarkableSet = new Set(result.unmarkable);
          const marked = result.conflicted.filter((p) => !unmarkableSet.has(p));
          if (marked.length > 0) {
            deps.stdout(`Conflicted — written with conflict markers (${marked.length}):`);
            for (const file of marked) deps.stdout(`  ${file}`);
          }
          if (result.unmarkable.length > 0) {
            deps.stdout(
              `Unmarkable — conflicts that could not take markers, A's content kept (${result.unmarkable.length}):`,
            );
            for (const file of result.unmarkable) deps.stdout(`  ${file}`);
          }
          deps.stdout(`Skipped (identical, ${result.skippedIdentical.length})`);
          // null is a legitimate outcome (no store / zero files written /
          // unknown origin node), NOT an error.
          if (result.combineNodeId !== null) {
            deps.stdout(`Combine node: ${result.combineNodeId}`);
          }
          for (const warning of result.warnings ?? []) {
            deps.stdout(`Warning: ${warning}`);
          }
        },
      ),
    );

  program
    .command("gc")
    .description(
      "prune old snapshot history from a project's shadow repo (dry-run by default). " +
        "Operates directly on $SOJOURN_HOME — the daemon does not need to be running. " +
        "gc only rewrites refs inside the project's SHADOW repo (never the user's own " +
        "working tree/.git). If a live daemon lands a new snapshot while gc is running, " +
        "gc detects it and aborts safely without pruning anything — re-run later to " +
        "complete it.",
    )
    .option("--project <id>", "project id (default: project for cwd)")
    .option("--days <n>", "keep snapshots younger than this many days", "30")
    .option("--archive-dir <path>", "write a backup bundle of pruned history here before deleting")
    .option("--run", "actually perform the prune (default: dry-run preview only)", false)
    .action(
      async (opts: { project?: string; days: string; archiveDir?: string; run: boolean }) => {
        const projectId = opts.project ?? projectIdFor(deps.cwd);
        const keepDays = Number.parseInt(opts.days, 10);
        if (!Number.isFinite(keepDays) || keepDays < 0) {
          deps.stderr(`error: --days must be a non-negative integer (got "${opts.days}")`);
          deps.exit(1);
          return;
        }

        const dbFile = path.join(deps.sojournHome, "sojourn.db");
        if (!fs.existsSync(dbFile)) {
          deps.stdout(`no sojourn database found at ${dbFile} — nothing to do.`);
          return;
        }

        const daemonPid = readPid(deps.sojournHome);
        if (daemonPid !== null && isPidAlive(daemonPid)) {
          deps.stdout(
            `note: daemon is running (pid ${daemonPid}) — if capture writes a snapshot while gc runs, gc will abort safely without pruning; re-run soj gc later to complete it.`,
          );
        }

        const store = new GraphStore(dbFile);
        try {
          const project = store.getProject(projectId);
          if (!project) {
            deps.stderr(`error: no project ${projectId} found in ${dbFile}`);
            deps.exit(1);
            return;
          }

          const shadowDir = path.join(deps.sojournHome, "snapshots", projectId);
          if (!fs.existsSync(shadowDir)) {
            deps.stdout(`no shadow snapshot repo for project ${projectId} at ${shadowDir} — nothing to do.`);
            return;
          }

          const worktreesRoot = path.join(deps.sojournHome, "worktrees", projectId);
          const extraPins = scanWorktreeManifestPins(worktreesRoot);
          const pins = collectPins(store, projectId, extraPins);

          const result = await gcShadowRepo(
            { shadowDir },
            { keepDays, pins, dryRun: !opts.run, archiveDir: opts.archiveDir },
          );

          // Synthesized rewind transcripts get the same age + pin + --run
          // gating as the shadow prune. Never runs ahead of it, and on a dry
          // run performs no filesystem writes at all.
          const sweep = await sweepSynthesizedTranscripts(store, projectId, {
            keepDays,
            dryRun: !opts.run,
          });

          deps.stdout(`project: ${project.name} (${project.id})`);
          deps.stdout(`keep window: ${keepDays} day(s)   pinned trees: ${pins.size}`);
          deps.stdout(
            renderTable(
              ["", "commits"],
              [
                ["kept", String(result.keptCommits)],
                ["pruned", String(result.prunedCommits)],
              ],
            ),
          );
          deps.stdout(
            renderTable(
              ["", "transcripts"],
              [
                ["kept", String(sweep.keptPinned + sweep.keptYoung)],
                ["swept", String(sweep.sweptPairs + sweep.sweptOrphanSidecars)],
              ],
            ),
          );
          deps.stdout(
            `reclaim${result.dryRun ? "able (estimate)" : "ed"}: ${formatBytes(result.reclaimedBytes)}` +
              ` (snapshots) + ${formatBytes(sweep.bytes)} (synthesized transcripts:` +
              ` ${sweep.sweptPairs} pair(s), ${sweep.sweptOrphanSidecars} orphan sidecar(s))`,
          );
          if (result.archived) {
            deps.stdout(`archived pruned history to: ${result.archived}`);
          }
          if (result.aborted === "concurrent_write") {
            deps.stdout(
              "gc aborted: a new snapshot landed while gc was running — nothing was pruned. Re-run soj gc to complete it.",
            );
          } else if (result.dryRun) {
            deps.stdout(
              result.prunedCommits > 0
                ? "dry run only — nothing was deleted. Re-run with --run to execute."
                : "nothing to prune.",
            );
          } else {
            deps.stdout("gc complete.");
          }
        } finally {
          store.close();
        }
      },
    );

  program
    .command("why <query>")
    .description('search the decision graph: "why/when did the agent do X?"')
    .option("--project <id>", "project id (default: project for cwd)")
    .option("--file <path>", "only turns that touched this file")
    .action(
      withDaemonErrorHandling(deps, async (query: string, opts: { project?: string; file?: string }) => {
        const projectId = opts.project ?? projectIdFor(deps.cwd);
        const params = new URLSearchParams({ projectId, q: query });
        if (opts.file) params.set("file", opts.file);
        const res = await client.get<{ hits: SearchHit[] }>(`/api/search?${params.toString()}`);
        if (res.status !== 200) {
          deps.stderr(`error: ${describeError(res.body)}`);
          deps.exit(1);
          return;
        }
        const hits = res.body?.hits ?? [];
        if (hits.length === 0) {
          deps.stdout(
            `no matches for "${query}"${opts.file ? ` touching ${opts.file}` : ""} in project ${projectId}.`,
          );
          deps.stdout(
            "sojourn only knows what the daemon captured — try a broader query, or `soj decisions` to list marks and flagged turns.",
          );
          return;
        }
        // Hits arrive score-ordered from the daemon (best first) — keep that order.
        for (const hit of hits) {
          deps.stdout(formatHitLine(hit));
          const snippet = excerpt(hit.snippet ?? "", 200);
          if (snippet.length > 0) deps.stdout(`    ${snippet}`);
        }
      }),
    );

  program
    .command("decisions")
    .description("list marked decisions/assumptions/checkpoints plus actively flagged turns")
    .option("--project <id>", "project id (default: project for cwd)")
    .option("--file <path>", "only turns that touched this file")
    .action(
      withDaemonErrorHandling(deps, async (opts: { project?: string; file?: string }) => {
        const projectId = opts.project ?? projectIdFor(deps.cwd);
        const params = new URLSearchParams({ projectId });
        if (opts.file) params.set("file", opts.file);
        const res = await client.get<{ hits: SearchHit[] }>(`/api/search?${params.toString()}`);
        if (res.status !== 200) {
          deps.stderr(`error: ${describeError(res.body)}`);
          deps.exit(1);
          return;
        }
        const kept = filterDecisionHits(res.body?.hits ?? []);
        if (kept.length === 0) {
          deps.stdout(
            `no decisions, assumptions, checkpoints, or flagged turns${opts.file ? ` touching ${opts.file}` : ""} in project ${projectId}. \`soj mark\` records one.`,
          );
          return;
        }
        for (const hit of kept) {
          deps.stdout(formatHitLine(hit));
          for (const flag of activeFlags(hit.node)) {
            deps.stdout(`    ⚑ ${flag.kind} (${flag.tier}/${flag.confidence}): ${excerpt(flag.evidence, 160)}`);
          }
        }
      }),
    );

  program
    .command("gate")
    .description(
      "CI-style check: exit 2 when active verified flags exist, 0 when clean, 3 when the daemon is unreachable",
    )
    .option("--session <id>", "gate one session (turn count and flag counts come from its health route)")
    .option("--project <id>", "project id (default: project for cwd)")
    .option("--include-advisory", "also gate on advisory (hedged, LLM-critic) flags", false)
    .action(async (opts: { session?: string; project?: string; includeAdvisory: boolean }) => {
      // Honest header: gate only checks what the local daemon recorded — it is
      // NOT a general correctness proof. Printed on every outcome.
      deps.stdout("checked: claims vs snapshots recorded by the local Sojourn daemon");
      try {
        const projectId = opts.project ?? projectIdFor(deps.cwd);
        let turns: number;
        let verifiedCount: number;
        let advisoryCount: number;
        let detail: Array<StoredFlag & { nodeId: string }> = [];

        if (opts.session) {
          const hres = await client.get<SessionHealth>(
            `/api/sessions/${encodeNodeId(opts.session)}/health`,
          );
          if (hres.status !== 200) {
            deps.stderr(`error: ${describeError(hres.body)}`);
            deps.exit(1);
            return;
          }
          turns = hres.body.turns;
          verifiedCount = hres.body.verifiedActive;
          advisoryCount = hres.body.advisoryActive;
          if (verifiedCount > 0 || (opts.includeAdvisory && advisoryCount > 0)) {
            // The verdict above comes from the health counts; the evidence
            // table is best-effort (the session's nodes live in some project
            // graph — cwd's by default).
            try {
              const g = await client.get<{ project: Project; sessions: SessionRow[]; nodes: ChronoNode[] }>(
                `/api/projects/${encodeNodeId(projectId)}/graph`,
              );
              if (g.status === 200) {
                detail = collectActiveFlags(g.body.nodes ?? [], opts.session, opts.includeAdvisory);
              }
            } catch {
              // evidence table unavailable — the exit code still stands
            }
          }
        } else {
          const g = await client.get<{ project: Project; sessions: SessionRow[]; nodes: ChronoNode[] }>(
            `/api/projects/${encodeNodeId(projectId)}/graph`,
          );
          if (g.status !== 200) {
            deps.stderr(`error: ${describeError(g.body)}`);
            deps.exit(1);
            return;
          }
          const nodes = g.body.nodes ?? [];
          turns = nodes.filter((n) => n.kind === "prompt").length;
          const all = collectActiveFlags(nodes, undefined, true);
          verifiedCount = all.filter((f) => f.tier === "verified").length;
          advisoryCount = all.filter((f) => f.tier === "advisory").length;
          detail = collectActiveFlags(nodes, undefined, opts.includeAdvisory);
        }

        const gatedCount = verifiedCount + (opts.includeAdvisory ? advisoryCount : 0);
        if (gatedCount > 0) {
          let headline = `gate failed: ${verifiedCount} active verified flag(s)`;
          if (opts.includeAdvisory && advisoryCount > 0) {
            headline += ` + ${advisoryCount} advisory flag(s) (gated by --include-advisory)`;
          }
          deps.stdout(headline);
          if (detail.length > 0) {
            deps.stdout(
              renderTable(
                ["node", "kind", "tier", "confidence", "evidence"],
                detail.map((f) => [f.nodeId, f.kind, f.tier, f.confidence, excerpt(f.evidence, 80)]),
              ),
            );
          } else {
            deps.stdout(
              `(flag details not found in project ${projectId} — if the session belongs to another project, pass --project)`,
            );
          }
          deps.exit(2);
          return;
        }

        deps.stdout(`gate passed: ${turns} turns, 0 active verified flags`);
        if (!opts.includeAdvisory && advisoryCount > 0) {
          deps.stdout(
            `note: ${advisoryCount} active advisory flag(s) (hedged, LLM-critic — not gated). Re-run with --include-advisory to gate on them.`,
          );
        }
      } catch (err) {
        if (isFetchFailure(err)) {
          deps.stderr(
            `sojourn daemon is not reachable at ${deps.baseUrl} — is it running? Try \`soj start\`. (exit 3 = could not check)`,
          );
          deps.exit(3);
          return;
        }
        throw err;
      }
    });

  program
    .command("mcp")
    .description(
      "run a read-only MCP stdio server over the graph (tools: sojourn_search, sojourn_decisions, sojourn_flags, sojourn_node). Add to Claude Code with: claude mcp add sojourn -- soj mcp",
    )
    .action(async () => {
      // stdout belongs to the MCP stdio transport from here on — the command
      // deliberately prints nothing itself.
      const { runMcpServer } = await import("./mcp.js");
      await runMcpServer({ baseUrl: deps.baseUrl, cwd: deps.cwd });
    });

  return program;
}

/** `[kind] node-id  gist` (+ active-flag markers) — shared by `soj why` and `soj decisions`. */
function formatHitLine(hit: SearchHit): string {
  const flagged = activeFlags(hit.node);
  const flagNote = flagged.length > 0 ? `  ⚑ ${flagged.map((f) => f.kind).join(",")}` : "";
  return `[${hit.node.kind}] ${hit.node.id}  ${gistOf(hit.node)}${flagNote}`;
}

/** Active (non-dismissed, non-auto-resolved) flags across nodes, optionally scoped to a session. */
function collectActiveFlags(
  nodes: ChronoNode[],
  sessionId: string | undefined,
  includeAdvisory: boolean,
): Array<StoredFlag & { nodeId: string }> {
  const out: Array<StoredFlag & { nodeId: string }> = [];
  for (const node of nodes) {
    if (sessionId !== undefined && node.sessionId !== sessionId) continue;
    for (const flag of activeFlags(node)) {
      if (!includeAdvisory && flag.tier !== "verified") continue;
      out.push({ ...flag, nodeId: node.id });
    }
  }
  return out;
}

async function resolveLatestSessionId(
  client: DaemonClient,
  deps: ProgramDeps,
): Promise<string | null> {
  const projectId = projectIdFor(deps.cwd);
  const res = await client.get<{ project: Project; sessions: SessionRow[]; nodes: ChronoNode[] }>(
    `/api/projects/${encodeNodeId(projectId)}/graph`,
  );
  if (res.status !== 200) return null;
  const sessions = res.body.sessions;
  if (!sessions || sessions.length === 0) return null;
  const latest = [...sessions].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  return latest?.id ?? null;
}

/** True when `err` looks like a fetch/network failure (daemon not reachable). */
function isFetchFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TypeError" && /fetch failed/i.test(err.message)) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ECONNRESET") return true;
  }
  return /ECONNREFUSED|ENOTFOUND|ECONNRESET/.test(err.message);
}

/**
 * Wraps a command action so that a raw fetch/connection failure (daemon not
 * running / not reachable) prints a friendly, actionable message instead of
 * a raw "fetch failed" error, and exits 1.
 */
function withDaemonErrorHandling(
  deps: ProgramDeps,
  action: (...args: any[]) => Promise<void>,
): (...args: any[]) => Promise<void> {
  return async (...args: any[]) => {
    try {
      await action(...args);
    } catch (err) {
      if (isFetchFailure(err)) {
        deps.stderr(
          `sojourn daemon is not reachable at ${deps.baseUrl} — is it running? Try \`soj start\`.`,
        );
        deps.exit(1);
        return;
      }
      throw err;
    }
  };
}

/** Preflight table order: the rows that need a decision come first. */
function harvestStatusRank(status: "clean" | "conflict" | "identical"): number {
  return status === "conflict" ? 0 : status === "clean" ? 1 : 2;
}

/** Shape of a harvest route's typed error body (daemon `handleHarvestError`). */
interface HarvestErrorBody {
  error?: unknown;
  /** absent on plain validation 400s (bad/missing worktreePath, bad mode) */
  code?: unknown;
  files?: unknown;
  /** present ONLY for partial_apply / mainline_drift (both 500s) */
  partial?: {
    applied?: unknown;
    conflicted?: unknown;
    remaining?: unknown;
    safetySnapshotRef?: unknown;
  };
}

/**
 * Harvest's error surface, including the one exit code that matters most.
 *
 * A `partial` payload (only `partial_apply` / `mainline_drift`) means the
 * MAINLINE WAS PARTIALLY WRITTEN — categorically different from a clean
 * pre-write refusal. It exits **2** and dumps the full partial state, so a
 * script can never mistake "we stopped before touching anything" (exit 1)
 * for "your working tree is now half-harvested" (exit 2).
 */
function reportHarvestError(deps: ProgramDeps, _status: number, body: unknown): void {
  deps.stderr(`error: ${describeError(body)}`);

  const typed: HarvestErrorBody =
    body && typeof body === "object" ? (body as HarvestErrorBody) : {};
  const code = typeof typed.code === "string" ? typed.code : null;

  if (typed.partial && typeof typed.partial === "object") {
    const p = typed.partial;
    deps.stderr("PARTIAL HARVEST — the mainline was modified before this failure.");
    deps.stderr(`  applied (${strList(p.applied).length}):`);
    for (const f of strList(p.applied)) deps.stderr(`    ${f}`);
    deps.stderr(`  conflicted (${strList(p.conflicted).length}):`);
    for (const f of strList(p.conflicted)) deps.stderr(`    ${f}`);
    deps.stderr(`  remaining (${strList(p.remaining).length}):`);
    for (const f of strList(p.remaining)) deps.stderr(`    ${f}`);
    deps.stderr(
      `  safety snapshot: ${typeof p.safetySnapshotRef === "string" ? p.safetySnapshotRef : "(none)"}`,
    );
    deps.stderr(
      "  Inspect the working tree before re-running — the safety snapshot above is the pre-harvest state.",
    );
    deps.exit(2);
    return;
  }

  const files = strList(typed.files);
  if (files.length > 0) {
    deps.stderr("files:");
    for (const f of files) deps.stderr(`  ${f}`);
  }
  if (code === "conflicts") {
    deps.stderr(
      "Re-run with --allow-conflicts to write conflict markers, or --mode patch.",
    );
  } else if (code === "read_failed") {
    deps.stderr(
      "The worktree's files could not be read — nothing was written to the mainline. Check permissions and that the worktree still exists.",
    );
  }
  deps.exit(1);
}

/** Shape of a combine route's typed error body (daemon `handleCombineError`).
 * `code` is absent on the plain validation 400s (missing/blank id, A === B). */
interface CombineErrorBody {
  error?: unknown;
  code?: unknown;
  files?: unknown;
  /** present ONLY for `write_failed` (the single 500) */
  partial?: {
    worktreePath?: unknown;
    applied?: unknown;
    conflicted?: unknown;
    remaining?: unknown;
  };
}

/**
 * Combine's error surface.
 *
 * EVERY code except `write_failed` is abort-clean — provably zero bytes
 * written anywhere — and exits 1. `write_failed` (the only 500) is the sole
 * code that leaves a half-built worktree on disk, and that worktree is
 * deliberately NOT deleted: it holds real merged content, so removing it
 * would turn combine into a source of data loss. It exits **2** and prints
 * where the worktree is, so a script can never confuse the two.
 */
function reportCombineError(deps: ProgramDeps, body: unknown): void {
  deps.stderr(`error: ${describeError(body)}`);

  const typed: CombineErrorBody = body && typeof body === "object" ? (body as CombineErrorBody) : {};
  // Never assume `code` is present — plain validation 400s omit it entirely.
  const code = typeof typed.code === "string" ? typed.code : null;

  const files = strList(typed.files);
  if (files.length > 0) {
    deps.stderr("files:");
    for (const f of files) deps.stderr(`  ${f}`);
  }

  if (typed.partial && typeof typed.partial === "object") {
    const p = typed.partial;
    deps.stderr("PARTIAL COMBINE — a half-built worktree was left on disk (NOT deleted:");
    deps.stderr("  it holds real merged content, so removing it would lose your work).");
    deps.stderr(
      `  worktree: ${typeof p.worktreePath === "string" ? p.worktreePath : "(unknown)"}`,
    );
    deps.stderr(`  applied (${strList(p.applied).length}):`);
    for (const f of strList(p.applied)) deps.stderr(`    ${f}`);
    deps.stderr(`  conflicted (${strList(p.conflicted).length}):`);
    for (const f of strList(p.conflicted)) deps.stderr(`    ${f}`);
    deps.stderr(`  remaining (${strList(p.remaining).length}):`);
    for (const f of strList(p.remaining)) deps.stderr(`    ${f}`);
    deps.stderr("  Inspect that worktree before re-running — nothing else was touched.");
    deps.exit(2);
    return;
  }

  if (code === "conflicts") {
    deps.stderr("Re-run with --allow-conflicts to write conflict markers.");
  }
  // Everything reaching here wrote nothing at all.
  deps.exit(1);
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function describeError(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    return String((body as { error: unknown }).error);
  }
  return typeof body === "string" ? body : JSON.stringify(body);
}

function formatProjectsTable(projects: Project[]): string {
  if (projects.length === 0) return "no projects.";
  const header = ["id", "name", "root", "createdAt"];
  const rows = projects.map((p) => [p.id, p.name, p.root, p.createdAt]);
  return renderTable(header, rows);
}

function formatFlagsTable(flags: Array<StoredFlag & { nodeId: string }>): string {
  if (flags.length === 0) return "no active flags.";
  const header = ["kind", "tier", "confidence", "node", "evidence"];
  const rows = flags.map((f) => [
    // Annotate settled flags so they can never read as active findings.
    f.autoResolved ? `${f.kind} (auto-resolved)` : f.kind,
    f.tier,
    f.confidence,
    f.nodeId,
    f.evidence,
  ]);
  return renderTable(header, rows);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Reads `.sojourn-restore.json` out of each `<worktreesRoot>/<worktree>/`
 * directory (restoreEngine's manifest, written on every restore) and
 * returns the set of tree hashes they reference, so `gc` never prunes a
 * snapshot a live restored worktree still depends on. `worktreesRoot` is
 * expected to be `<sojournHome>/worktrees/<projectId>` (restoreEngine nests
 * one directory per project, one subdirectory per restore).
 */
function scanWorktreeManifestPins(worktreesRoot: string): Set<string> {
  const pins = new Set<string>();
  if (!fs.existsSync(worktreesRoot)) return pins;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(worktreesRoot, { withFileTypes: true });
  } catch {
    return pins;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(worktreesRoot, entry.name, ".sojourn-restore.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { treeHash?: unknown };
      if (typeof manifest.treeHash === "string" && manifest.treeHash.length > 0) {
        pins.add(manifest.treeHash);
      }
    } catch {
      // malformed/partial manifest — skip it rather than failing the whole gc run
    }
  }
  return pins;
}

// ——— synthesized-transcript retention sweep (review Minor 6) ———————————
//
// `soj gc` governed only shadow repos, so the synthesized rewind transcripts
// `executeRewind` writes into ~/.claude/projects accumulated forever. This
// sweep gives them the SAME retention story as snapshots: age-gated by
// --days, pin-gated, and strictly behind --run.
//
// It lives in the CLI, not core, because packages/core cannot import
// packages/adapter-claude and core/src/snapshot/gc.ts is deliberately
// filesystem-I/O-free — the same division of labor as
// `scanWorktreeManifestPins` above: the CLI owns the filesystem scan, core
// stays pure.

/** Node kinds core's `collectPins` treats as pinned waypoints (gc.ts). */
const PINNED_NODE_KINDS = new Set(["decision", "assumption", "checkpoint"]);

export interface TranscriptSweepResult {
  /** transcript+sidecar pairs eligible (dry run) or actually deleted */
  sweptPairs: number;
  /** inert sidecars with no transcript, eligible or deleted */
  sweptOrphanSidecars: number;
  /** pairs skipped because their origin node is a live/pinned waypoint */
  keptPinned: number;
  /** pairs skipped because they are younger than the keep window */
  keptYoung: number;
  bytes: number;
}

/**
 * Sweeps synthesized rewind transcripts belonging to `projectId`.
 *
 * SAFETY — the single most important invariant here: `orphan_transcript` is
 * the ORDINARY shape of every NATIVE Claude session (a `.jsonl` with no
 * sidecar). Deleting those would destroy the user's real session history.
 * Only `paired` (synthesized transcript + its sidecar) and `orphan_sidecar`
 * (inert residue) are EVER candidates; `unreadable_sidecar` is skipped too,
 * since without a parsed sidecar we cannot prove the pair is ours.
 */
async function sweepSynthesizedTranscripts(
  store: GraphStore,
  projectId: string,
  opts: { keepDays: number; dryRun: boolean; now?: number },
): Promise<TranscriptSweepResult> {
  const result: TranscriptSweepResult = {
    sweptPairs: 0,
    sweptOrphanSidecars: 0,
    keptPinned: 0,
    keptYoung: 0,
    bytes: 0,
  };

  // Only sessions of THIS project may be swept. A synthesized transcript's
  // sidecar records the ORIGIN session, which is what ties it to a project —
  // the new session id is just the transcript's filename.
  const ownSessionIds = new Set(store.getSessions(projectId).map((s) => s.id));
  if (ownSessionIds.size === 0) return result;

  // Nodes worth keeping the exact conversation for: the same predicate core's
  // collectPins uses for snapshot trees, applied to transcripts.
  const pinnedNodeIds = new Set<string>();
  for (const node of store.getGraph(projectId)) {
    if (PINNED_NODE_KINDS.has(node.kind) || (node.flags?.length ?? 0) > 0) {
      pinnedNodeIds.add(node.id);
    }
  }

  const cutoff = (opts.now ?? Date.now()) - opts.keepDays * 86400_000;

  for (const subdir of listClaudeProjectSubdirs()) {
    for (const entry of await listRewindSidecars(subdir)) {
      // ────────────────────────────────────────────────────────────────
      // THE GUARD. Anything not explicitly whitelisted here is untouchable,
      // and `orphan_transcript` (every native session) can never reach the
      // deletion code below.
      if (entry.status !== "paired" && entry.status !== "orphan_sidecar") continue;
      const sidecar = entry.sidecar;
      if (sidecar === null) continue;
      // ────────────────────────────────────────────────────────────────

      if (!ownSessionIds.has(sidecar.originSessionId)) continue;

      if (pinnedNodeIds.has(sidecar.originNodeId)) {
        result.keptPinned++;
        continue;
      }

      const isPair = entry.status === "paired";
      // Age off the artifact that actually exists on disk.
      const mtime = fileMtimeMs(isPair ? entry.transcriptPath : entry.sidecarPath);
      if (mtime === null) continue;
      if (mtime >= cutoff) {
        result.keptYoung++;
        continue;
      }

      const bytes =
        fileSizeBytes(entry.sidecarPath) + (isPair ? fileSizeBytes(entry.transcriptPath) : 0);

      if (!opts.dryRun) {
        // SIDECAR FIRST, mirroring executeRewind's write invariant: a
        // transcript without its sidecar is exactly the phantom-session
        // hazard (review I3). If the second unlink fails we are left with an
        // inert orphan_sidecar, which the next sweep cleans up — never a
        // sidecar-less synthesized transcript.
        if (!tryUnlink(entry.sidecarPath)) continue;
        if (isPair) tryUnlink(entry.transcriptPath);
      }

      result.bytes += bytes;
      if (isPair) result.sweptPairs++;
      else result.sweptOrphanSidecars++;
    }
  }

  return result;
}

/** Immediate subdirectories of ~/.claude/projects (one per encoded repo root). */
function listClaudeProjectSubdirs(): string[] {
  const root = claudeProjectsDir();
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

function fileMtimeMs(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function fileSizeBytes(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function tryUnlink(file: string): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cols: string[]) =>
    cols.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}
