import { describe, it, expect } from "vitest";
import { runCritic, MAX_TEXT_CHARS, MAX_DIFF_FILES } from "../../src/flags/critic.js";
import type { CriticLLM } from "../../src/flags/critic.js";
import type { ChronoNode } from "../../src/types.js";
import type { CheckContext, SnapshotterLike, FetchJson } from "../../src/interfaces.js";

function makeNode(overrides: Partial<ChronoNode> = {}): ChronoNode {
  return {
    id: "claude:node-1",
    parentId: null,
    kind: "assistant",
    cli: "claude",
    sessionId: "s1",
    projectId: "p1",
    timestamp: new Date().toISOString(),
    snapshotRef: "deadbeef",
    label: null,
    summary: "",
    content: "I updated the config to use the new default timeout.",
    meta: { nativeUuid: "node-1" },
    ...overrides,
  };
}

function makeSnapshotter(): SnapshotterLike {
  return {
    async init() {},
    async snapshot() {
      return "tree";
    },
    async hasTree() {
      return true;
    },
    async diff() {
      return [];
    },
    async diffFile() {
      return "";
    },
    async listFiles() {
      return [];
    },
    async readFile() {
      return null;
    },
    async restoreToWorktree() {},
  };
}

function makeCtx(overrides: Partial<CheckContext> = {}): CheckContext {
  const node = overrides.node ?? makeNode();
  return {
    node,
    priorNodes: [node],
    diff: [{ path: "src/config.ts", status: "M" }],
    parentTree: "parent-tree",
    nodeTree: "node-tree",
    projectRoot: "/tmp/project",
    snapshotter: makeSnapshotter(),
    fetchJson: (async () => ({ status: 200, body: {} })) as FetchJson,
    ...overrides,
  };
}

function fakeLlm(response: string): CriticLLM {
  return {
    async complete() {
      return response;
    },
  };
}

describe("runCritic — mapping", () => {
  it("maps assumptions to unstated_assumption flags, advisory tier, llm_critic source", async () => {
    const llm = fakeLlm(
      JSON.stringify({
        assumptions: [{ text: "Assumed the timeout should default to 30s", confidence: "medium" }],
        possible_hallucinations: [],
      }),
    );
    const flags = await runCritic(llm, makeCtx());
    expect(flags).toHaveLength(1);
    expect(flags[0].kind).toBe("unstated_assumption");
    expect(flags[0].tier).toBe("advisory");
    expect(flags[0].source).toBe("llm_critic");
    expect(flags[0].confidence).toBe("medium");
    expect(flags[0].evidence).toBe("Assumed: Assumed the timeout should default to 30s");
  });

  it("maps possible_hallucinations to possible_hallucination flags", async () => {
    const llm = fakeLlm(
      JSON.stringify({
        assumptions: [],
        possible_hallucinations: [
          { claim: "the tests pass", reason: "no test run is visible in the diff", confidence: "low" },
        ],
      }),
    );
    const flags = await runCritic(llm, makeCtx());
    expect(flags).toHaveLength(1);
    expect(flags[0].kind).toBe("possible_hallucination");
    expect(flags[0].tier).toBe("advisory");
    expect(flags[0].source).toBe("llm_critic");
    expect(flags[0].confidence).toBe("low");
    expect(flags[0].evidence).toBe("Possible: the tests pass — no test run is visible in the diff");
  });

  it("maps both categories together, preserving order (assumptions first)", async () => {
    const llm = fakeLlm(
      JSON.stringify({
        assumptions: [{ text: "assumed X", confidence: "low" }],
        possible_hallucinations: [{ claim: "claimed Y", reason: "unsubstantiated", confidence: "medium" }],
      }),
    );
    const flags = await runCritic(llm, makeCtx());
    expect(flags).toHaveLength(2);
    expect(flags[0].kind).toBe("unstated_assumption");
    expect(flags[1].kind).toBe("possible_hallucination");
  });
});

describe("runCritic — confidence clamping", () => {
  it("clamps high confidence to medium for assumptions", async () => {
    const llm = fakeLlm(
      JSON.stringify({
        assumptions: [{ text: "assumed something certain", confidence: "high" }],
        possible_hallucinations: [],
      }),
    );
    const flags = await runCritic(llm, makeCtx());
    expect(flags).toHaveLength(1);
    expect(flags[0].confidence).toBe("medium");
    expect(flags[0].confidence).not.toBe("high");
  });

  it("clamps high confidence to medium for possible_hallucinations", async () => {
    const llm = fakeLlm(
      JSON.stringify({
        assumptions: [],
        possible_hallucinations: [{ claim: "claimed Z", reason: "no evidence", confidence: "high" }],
      }),
    );
    const flags = await runCritic(llm, makeCtx());
    expect(flags).toHaveLength(1);
    expect(flags[0].confidence).toBe("medium");
  });

  it("never emits a high confidence flag under any input", async () => {
    const llm = fakeLlm(
      JSON.stringify({
        assumptions: [
          { text: "a", confidence: "high" },
          { text: "b", confidence: "medium" },
          { text: "c", confidence: "low" },
        ],
        possible_hallucinations: [{ claim: "d", reason: "r", confidence: "high" }],
      }),
    );
    const flags = await runCritic(llm, makeCtx());
    expect(flags.every((f) => f.confidence === "low" || f.confidence === "medium")).toBe(true);
  });
});

describe("runCritic — fenced JSON tolerance", () => {
  it("strips ```json fences before parsing", async () => {
    const body = JSON.stringify({
      assumptions: [{ text: "assumed inside fence", confidence: "low" }],
      possible_hallucinations: [],
    });
    const llm = fakeLlm("```json\n" + body + "\n```");
    const flags = await runCritic(llm, makeCtx());
    expect(flags).toHaveLength(1);
    expect(flags[0].evidence).toBe("Assumed: assumed inside fence");
  });

  it("strips plain ``` fences (no json tag) before parsing", async () => {
    const body = JSON.stringify({
      assumptions: [],
      possible_hallucinations: [{ claim: "x", reason: "y", confidence: "low" }],
    });
    const llm = fakeLlm("```\n" + body + "\n```");
    const flags = await runCritic(llm, makeCtx());
    expect(flags).toHaveLength(1);
    expect(flags[0].kind).toBe("possible_hallucination");
  });
});

describe("runCritic — malformed output safety", () => {
  it("returns [] for non-JSON garbage, never throws", async () => {
    const llm = fakeLlm("I cannot comply with this request.");
    await expect(runCritic(llm, makeCtx())).resolves.toEqual([]);
  });

  it("returns [] for JSON that doesn't match the expected shape", async () => {
    const llm = fakeLlm(JSON.stringify({ foo: "bar" }));
    const flags = await runCritic(llm, makeCtx());
    expect(flags).toEqual([]);
  });

  it("returns [] for truncated/invalid JSON", async () => {
    const llm = fakeLlm('{"assumptions": [{"text": "cut off"');
    const flags = await runCritic(llm, makeCtx());
    expect(flags).toEqual([]);
  });

  it("returns [] when the LLM call itself throws", async () => {
    const llm: CriticLLM = {
      async complete() {
        throw new Error("network down");
      },
    };
    await expect(runCritic(llm, makeCtx())).resolves.toEqual([]);
  });

  it("skips malformed entries within an otherwise valid array instead of throwing", async () => {
    const llm = fakeLlm(
      JSON.stringify({
        assumptions: [{ text: "good one", confidence: "low" }, { confidence: "medium" }, "not an object"],
        possible_hallucinations: [],
      }),
    );
    const flags = await runCritic(llm, makeCtx());
    expect(flags).toHaveLength(1);
    expect(flags[0].evidence).toBe("Assumed: good one");
  });
});

describe("runCritic — bounded prompt size", () => {
  it("truncates a huge assistant message to MAX_TEXT_CHARS and bounds total prompt length", async () => {
    const hugeText = "x".repeat(50_000);
    let capturedPrompt = "";
    const llm: CriticLLM = {
      async complete(prompt: string) {
        capturedPrompt = prompt;
        return JSON.stringify({ assumptions: [], possible_hallucinations: [] });
      },
    };
    const node = makeNode({ content: hugeText });
    await runCritic(llm, makeCtx({ node, priorNodes: [node] }));

    expect(capturedPrompt).toContain(
      `\n[...truncated ${50_000 - MAX_TEXT_CHARS} chars]`,
    );
    expect(capturedPrompt.length).toBeLessThan(20_000);
  });

  it("caps the diff summary at MAX_DIFF_FILES entries with an overflow line", async () => {
    const bigDiff = Array.from({ length: 500 }, (_, i) => ({
      path: `src/file${i}.ts`,
      status: "M" as const,
    }));
    let capturedPrompt = "";
    const llm: CriticLLM = {
      async complete(prompt: string) {
        capturedPrompt = prompt;
        return JSON.stringify({ assumptions: [], possible_hallucinations: [] });
      },
    };
    await runCritic(llm, makeCtx({ diff: bigDiff }));

    const fileLineCount = bigDiff
      .slice(0, MAX_DIFF_FILES)
      .filter((d) => capturedPrompt.includes(`M ${d.path}`)).length;
    expect(fileLineCount).toBe(MAX_DIFF_FILES);
    expect(capturedPrompt).toContain(
      `…and ${500 - MAX_DIFF_FILES} more changed files`,
    );
  });
});

describe("runCritic — empty categories", () => {
  it("returns [] when both categories are empty arrays", async () => {
    const llm = fakeLlm(JSON.stringify({ assumptions: [], possible_hallucinations: [] }));
    const flags = await runCritic(llm, makeCtx());
    expect(flags).toEqual([]);
  });

  it("returns [] when the node has no extractable text content", async () => {
    const llm = fakeLlm(
      JSON.stringify({
        assumptions: [{ text: "should not be reached", confidence: "low" }],
        possible_hallucinations: [],
      }),
    );
    const node = makeNode({ content: { type: "tool_use", input: {} } });
    const flags = await runCritic(llm, makeCtx({ node }));
    expect(flags).toEqual([]);
  });
});
