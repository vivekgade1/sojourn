export { parseSessionJsonl } from "./parser.js";
export { claudeProjectsDir, watchGlob } from "./transcriptLocator.js";
export { buildResumeCommand } from "./driver.js";
export type { BuildResumeCommandOptions } from "./driver.js";
export { planRewind, executeRewind, rewindSidecarPathFor, SojournRewindError } from "./rewind.js";
export type {
  ClaudeRewindPlan,
  PlanRewindInput,
  RewindSidecar,
  SojournRewindErrorCode,
} from "./rewind.js";

// Future tasks append driver exports here (e.g. --resume/--fork-session
// conversation-restore driver, hook script entrypoints). Leave in place.
