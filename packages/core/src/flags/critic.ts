import type { Flag } from "../types.js";
import type { CheckContext } from "../interfaces.js";
import { getNodeText } from "./claims.js";

/**
 * Injected LLM completion client for the Tier-2 advisory critic. The daemon
 * supplies the real implementation (API-key handling, fetch to the
 * provider); this module never makes network calls itself.
 */
export interface CriticLLM {
  complete(prompt: string): Promise<string>;
}

type RawConfidence = "low" | "medium" | "high";
type AdvisoryConfidence = "low" | "medium";

interface RawAssumption {
  text: string;
  confidence: RawConfidence;
}

interface RawHallucination {
  claim: string;
  reason: string;
  confidence: RawConfidence;
}

interface RawCriticOutput {
  assumptions: RawAssumption[];
  possible_hallucinations: RawHallucination[];
}

const SYSTEM_PREAMBLE = `You are an advisory reviewer for an AI coding assistant's work. You will be given the assistant's message to the user and a summary of the file changes made in this step.

List two things, based ONLY on the assistant message and diff summary provided:
(a) unstated assumptions — choices the assistant made without being explicitly instructed to make them;
(b) claims the assistant made that might be false (possible hallucinations) — e.g. references to behavior, APIs, or effects that are not substantiated by the diff summary.

Respond with STRICT JSON and nothing else — no prose, no markdown fences. The JSON must match exactly this shape:
{"assumptions":[{"text":string,"confidence":"low"|"medium"|"high"}],"possible_hallucinations":[{"claim":string,"reason":string,"confidence":"low"|"medium"|"high"}]}

If there are no assumptions, use an empty array. If there are no possible hallucinations, use an empty array.`;

function summarizeDiff(diff: CheckContext["diff"]): string {
  if (diff.length === 0) return "(no file changes)";
  return diff
    .map((d) => (d.oldPath ? `${d.status} ${d.oldPath} -> ${d.path}` : `${d.status} ${d.path}`))
    .join("\n");
}

function buildPrompt(assistantText: string, ctx: CheckContext): string {
  const diffSummary = summarizeDiff(ctx.diff);
  return `${SYSTEM_PREAMBLE}

Assistant message:
"""
${assistantText}
"""

File diff summary:
"""
${diffSummary}
"""`;
}

/** Strips a leading/trailing ```json ... ``` or ``` ... ``` fence, if present. */
function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced) return fenced[1].trim();
  return trimmed;
}

function clampConfidence(confidence: unknown): AdvisoryConfidence {
  if (confidence === "low") return "low";
  // Advisory tier never claims high confidence — clamp both "high" and any
  // unrecognized value down to a safe default.
  if (confidence === "medium") return "medium";
  if (confidence === "high") return "medium";
  return "medium";
}

function isRawAssumption(value: unknown): value is RawAssumption {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.text === "string";
}

function isRawHallucination(value: unknown): value is RawHallucination {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.claim === "string" && typeof v.reason === "string";
}

function parseCriticOutput(raw: string): RawCriticOutput | null {
  let stripped: string;
  try {
    stripped = stripFences(raw);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const assumptionsRaw = obj.assumptions;
  const hallucinationsRaw = obj.possible_hallucinations;

  if (assumptionsRaw !== undefined && !Array.isArray(assumptionsRaw)) return null;
  if (hallucinationsRaw !== undefined && !Array.isArray(hallucinationsRaw)) return null;

  const assumptions: RawAssumption[] = Array.isArray(assumptionsRaw)
    ? assumptionsRaw.filter(isRawAssumption)
    : [];
  const possible_hallucinations: RawHallucination[] = Array.isArray(hallucinationsRaw)
    ? hallucinationsRaw.filter(isRawHallucination)
    : [];

  return { assumptions, possible_hallucinations };
}

/**
 * Runs the Tier-2 advisory critic: an opt-in LLM pass over the assistant's
 * message and this step's file diff, surfacing unstated assumptions and
 * possible hallucinations. Always returns `tier: "advisory"`,
 * `source: "llm_critic"`, confidence clamped to low|medium (advisory never
 * claims high certainty). Malformed or unparseable LLM output resolves to an
 * empty array — this check must never throw.
 */
export async function runCritic(llm: CriticLLM, ctx: CheckContext): Promise<Flag[]> {
  const text = getNodeText(ctx.node);
  if (text === null) return [];

  const prompt = buildPrompt(text, ctx);

  let raw: string;
  try {
    raw = await llm.complete(prompt);
  } catch {
    return [];
  }

  const parsed = parseCriticOutput(raw);
  if (parsed === null) return [];

  const flags: Flag[] = [];

  for (const a of parsed.assumptions) {
    flags.push({
      kind: "unstated_assumption",
      tier: "advisory",
      confidence: clampConfidence(a.confidence),
      evidence: `Assumed: ${a.text}`,
      source: "llm_critic",
    });
  }

  for (const h of parsed.possible_hallucinations) {
    flags.push({
      kind: "possible_hallucination",
      tier: "advisory",
      confidence: clampConfidence(h.confidence),
      evidence: `Possible: ${h.claim} — ${h.reason}`,
      source: "llm_critic",
    });
  }

  return flags;
}
