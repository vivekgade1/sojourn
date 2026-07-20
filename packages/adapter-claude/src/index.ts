export { parseSessionJsonl } from "./parser.js";
export { claudeProjectsDir, watchGlob } from "./transcriptLocator.js";
export { buildResumeCommand } from "./driver.js";
export type { BuildResumeCommandOptions } from "./driver.js";
export {
  planRewind,
  executeRewind,
  rewindSidecarPathFor,
  listRewindSidecars,
  SojournRewindError,
} from "./rewind.js";
export type {
  ClaudeRewindPlan,
  ExecuteRewindDeps,
  PlanRewindInput,
  RewindFs,
  RewindSidecar,
  RewindSidecarEntry,
  RewindSidecarPairStatus,
  SojournRewindErrorCode,
} from "./rewind.js";

// Future tasks append driver exports here (e.g. --resume/--fork-session
// conversation-restore driver, hook script entrypoints). Leave in place.
