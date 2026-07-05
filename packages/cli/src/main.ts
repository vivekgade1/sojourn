#!/usr/bin/env node
import { buildProgram, defaultDeps } from "./program.js";

const program = buildProgram(defaultDeps());

try {
  await program.parseAsync(process.argv);
} catch (err) {
  const anyErr = err as { code?: string; exitCode?: number; message?: string };
  if (typeof anyErr.exitCode === "number") {
    process.exit(anyErr.exitCode);
  }
  process.stderr.write(`${anyErr.message ?? String(err)}\n`);
  process.exit(1);
}
