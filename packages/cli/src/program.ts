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
} from "@sojourn/core";
import { DaemonClient, encodeNodeId } from "./client.js";
import {
  resolveDaemonEntry,
  readPid,
  writePid,
  removePidfile,
  isPidAlive,
  killPid,
  pollHealth,
  isDaemonProcess,
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
  return {
    baseUrl,
    sojournHome: overrides.sojournHome ?? sojournHome(),
    cwd: overrides.cwd ?? process.cwd(),
    stdout: overrides.stdout ?? ((line) => process.stdout.write(line + "\n")),
    stderr: overrides.stderr ?? ((line) => process.stderr.write(line + "\n")),
    spawnDaemon:
      overrides.spawnDaemon ??
      ((entry, env) => {
        const child = spawn(process.execPath, [entry], {
          detached: true,
          stdio: "ignore",
          env,
        });
        child.unref();
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
      if (pid === null || !isPidAlive(pid)) {
        deps.stdout("daemon: stopped");
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
            `reclaim${result.dryRun ? "able (estimate)" : "ed"}: ${formatBytes(result.reclaimedBytes)}`,
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

  return program;
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

function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cols: string[]) =>
    cols.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}
