import path from "node:path";
import fs from "node:fs";
import type { ChronoNode, Flag } from "../types.js";
import type { CheckContext, FlagCheck } from "../interfaces.js";
import { getNodeText } from "./claims.js";

const JS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const PY_EXT = ".py";

const NODE_BUILTINS = new Set([
  "fs",
  "path",
  "os",
  "crypto",
  "http",
  "https",
  "url",
  "util",
  "events",
  "stream",
  "child_process",
  "zlib",
  "net",
  "tls",
  "dns",
  "readline",
  "assert",
  "buffer",
  "process",
  "worker_threads",
  "cluster",
  "v8",
  "vm",
  "querystring",
  "string_decoder",
  "timers",
  "tty",
  "dgram",
  "perf_hooks",
  "async_hooks",
  "inspector",
]);

const PYTHON_STDLIB = new Set([
  "os",
  "sys",
  "re",
  "json",
  "math",
  "random",
  "datetime",
  "time",
  "collections",
  "itertools",
  "functools",
  "typing",
  "pathlib",
  "subprocess",
  "shutil",
  "tempfile",
  "unittest",
  "logging",
  "argparse",
  "dataclasses",
  "enum",
  "abc",
  "io",
  "csv",
  "sqlite3",
  "hashlib",
  "base64",
  "urllib",
  "http",
  "socket",
  "threading",
  "multiprocessing",
  "asyncio",
  "contextlib",
  "copy",
  "pickle",
  "struct",
  "textwrap",
  "traceback",
  "uuid",
  "warnings",
  "weakref",
  "xml",
  "zipfile",
  "glob",
  "fnmatch",
  "statistics",
  "secrets",
  "string",
  "types",
  "inspect",
  "importlib",
  "operator",
  "queue",
  "select",
  "signal",
  "heapq",
  "bisect",
  "array",
  "decimal",
  "fractions",
  "numbers",
  "pprint",
  "reprlib",
  "difflib",
  "unicodedata",
  "codecs",
  "encodings",
  "locale",
  "gettext",
]);

type Lang = "js" | "py";

/** Strip subpaths from an import specifier, keeping the bare package name.
 * Handles scoped packages (`@scope/pkg/sub` -> `@scope/pkg`) and plain
 * packages (`pkg/sub` -> `pkg`). */
function toBarePackageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.slice(0, 2).join("/");
  }
  return specifier.split("/")[0];
}

function isRelativeImport(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/");
}

/** Path aliases / subpath imports that never name a registry package:
 * `@/…` (bundler/tsconfig alias), `~/…` (alias convention), and `#…`
 * (Node subpath imports, resolved via package.json "imports"). */
function isAliasedImport(specifier: string): boolean {
  return specifier.startsWith("@/") || specifier.startsWith("~/") || specifier.startsWith("#");
}

function isNodeBuiltin(name: string): boolean {
  if (name.startsWith("node:")) return true;
  return NODE_BUILTINS.has(name);
}

interface Candidate {
  name: string;
  lang: Lang;
}

function extractJsImports(content: string): string[] {
  const specifiers: string[] = [];
  const importFromRe = /import\s+(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/g;
  const requireRe = /require\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = importFromRe.exec(content)) !== null) specifiers.push(m[1]);
  while ((m = requireRe.exec(content)) !== null) specifiers.push(m[1]);
  return specifiers;
}

function extractPyImports(content: string): string[] {
  const specifiers: string[] = [];
  const importRe = /^\s*import\s+([a-zA-Z0-9_.]+)/gm;
  const fromRe = /^\s*from\s+([a-zA-Z0-9_.]+)\s+import\s+/gm;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(content)) !== null) specifiers.push(m[1]);
  while ((m = fromRe.exec(content)) !== null) specifiers.push(m[1]);
  return specifiers;
}

function pyTopLevelModule(specifier: string): string {
  return specifier.split(".")[0];
}

/** Walk from the file's directory all the way up to the project root
 * (tree-relative "."), MERGING dependencies+devDependencies (+peer/optional)
 * from EVERY package.json found along the way. In a monorepo a dependency
 * declared only in the ROOT package.json (e.g. a shared devDependency like
 * `vitest`) must still count as "known" for a nested package's imports —
 * stopping at the first (nearest) package.json would miss it and risk a
 * false package_hallucination flag. */
async function nearestPackageJsonDeps(
  snapshotter: NonNullable<CheckContext["snapshotter"]>,
  nodeTree: string,
  fromFile: string,
): Promise<Set<string>> {
  const deps = new Set<string>();
  let dir = path.posix.dirname(fromFile);
  const seen = new Set<string>();
  while (true) {
    if (seen.has(dir)) break;
    seen.add(dir);
    const candidate = dir === "." ? "package.json" : path.posix.join(dir, "package.json");
    const raw = await snapshotter.readFile(nodeTree, candidate);
    if (raw !== null) {
      try {
        const pkg = JSON.parse(raw) as Record<string, unknown>;
        for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
          const section = pkg[field];
          if (section && typeof section === "object") {
            for (const name of Object.keys(section as Record<string, unknown>)) deps.add(name);
          }
        }
      } catch {
        // malformed package.json: ignore, keep walking up
      }
    }
    if (dir === "." || dir === "/") break;
    dir = path.posix.dirname(dir);
  }
  return deps;
}

/**
 * True when Python module `m` resolves to a LOCAL module in the snapshot
 * tree — an `m.py` file or an `m/` package directory, either at the tree
 * root or next to the importing file. Local modules must never be looked up
 * on PyPI (a 404 there would be a guaranteed false package_hallucination).
 */
async function isLocalPyModule(
  snapshotter: NonNullable<CheckContext["snapshotter"]>,
  nodeTree: string,
  moduleName: string,
  importingFile: string,
  cache: { files: string[] | null },
): Promise<boolean> {
  if (cache.files === null) {
    try {
      cache.files = await snapshotter.listFiles(nodeTree);
    } catch {
      cache.files = [];
    }
  }
  const roots = new Set<string>(["."]);
  roots.add(path.posix.dirname(importingFile));
  for (const root of roots) {
    const filePath = root === "." ? `${moduleName}.py` : path.posix.join(root, `${moduleName}.py`);
    const dirPrefix = root === "." ? `${moduleName}/` : path.posix.join(root, moduleName) + "/";
    if (cache.files.some((f) => f === filePath || f.startsWith(dirPrefix))) return true;
  }
  return false;
}

function existsInNodeModules(projectRoot: string, name: string): boolean {
  try {
    return fs.existsSync(path.join(projectRoot, "node_modules", name));
  } catch {
    return false;
  }
}

function registryUrl(candidate: Candidate): string {
  if (candidate.lang === "py") {
    return `https://pypi.org/pypi/${candidate.name}/json`;
  }
  return `https://registry.npmjs.org/${candidate.name}`;
}

export const packagesCheck: FlagCheck = {
  kind: "package_hallucination",

  appliesTo(node: ChronoNode): boolean {
    return node.kind === "assistant" && getNodeText(node) !== null;
  },

  async run(ctx: CheckContext): Promise<Flag[]> {
    if (ctx.nodeTree === null || ctx.snapshotter === null) return [];
    const text = getNodeText(ctx.node);
    if (text === null) return [];

    const relevantFiles = ctx.diff.filter(
      (d) =>
        (d.status === "A" || d.status === "M") &&
        (JS_EXTS.has(path.posix.extname(d.path)) || d.path.endsWith(PY_EXT)),
    );
    if (relevantFiles.length === 0) return [];

    const candidatesByName = new Map<string, Candidate>();
    const depsCache = new Map<string, Set<string>>();
    // Lazily-loaded full file list of nodeTree, shared across all Python
    // local-module checks in this run.
    const treeFilesCache: { files: string[] | null } = { files: null };

    for (const fileChange of relevantFiles) {
      const content = await ctx.snapshotter.readFile(ctx.nodeTree, fileChange.path);
      if (content === null) continue;

      const isPy = fileChange.path.endsWith(PY_EXT);
      const lang: Lang = isPy ? "py" : "js";
      const rawSpecifiers = isPy ? extractPyImports(content) : extractJsImports(content);

      let deps = depsCache.get(fileChange.path);
      if (!deps) {
        deps = isPy
          ? new Set<string>()
          : await nearestPackageJsonDeps(ctx.snapshotter, ctx.nodeTree, fileChange.path);
        depsCache.set(fileChange.path, deps);
      }

      for (const raw of rawSpecifiers) {
        if (isPy) {
          if (isRelativeImport(raw)) continue;
          const top = pyTopLevelModule(raw);
          if (PYTHON_STDLIB.has(top)) continue;
          // Local module in the same tree (a `m/` package dir or an `m.py`
          // file, at the tree root or next to the importing file): never a
          // PyPI package — skip before any registry lookup.
          if (
            await isLocalPyModule(ctx.snapshotter, ctx.nodeTree, top, fileChange.path, treeFilesCache)
          )
            continue;
          if (!candidatesByName.has(`py:${top}`)) candidatesByName.set(`py:${top}`, { name: top, lang: "py" });
        } else {
          if (isRelativeImport(raw)) continue;
          if (isAliasedImport(raw)) continue;
          const bare = toBarePackageName(raw);
          if (isNodeBuiltin(bare)) continue;
          if (deps.has(bare)) continue;
          if (existsInNodeModules(ctx.projectRoot, bare)) continue;
          if (!candidatesByName.has(`js:${bare}`)) candidatesByName.set(`js:${bare}`, { name: bare, lang: "js" });
        }
      }
    }

    if (candidatesByName.size === 0) return [];

    const flags: Flag[] = [];
    const cache = new Map<string, { status: number } | "error">();

    for (const candidate of candidatesByName.values()) {
      const cacheKey = `${candidate.lang}:${candidate.name}`;
      let result = cache.get(cacheKey);
      if (!result) {
        try {
          const res = await ctx.fetchJson(registryUrl(candidate));
          result = { status: res.status };
        } catch {
          result = "error";
        }
        cache.set(cacheKey, result);
      }

      if (result === "error") continue; // fail open: network error -> no flag
      if (result.status === 404) {
        const registryName = candidate.lang === "py" ? "PyPI" : "the npm registry";
        flags.push({
          kind: "package_hallucination",
          tier: "verified",
          confidence: "high",
          evidence: `claimed/used import of package \`${candidate.name}\`; ${registryName} returned 404 (not found) for that package name`,
          source: "deterministic",
        });
      }
      // any other status (200, 500, etc. besides 404): fail open, no flag.
    }

    return flags;
  },
};
