import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseOpenCodeMessages } from "../src/parser.js";
import type { ChronoNode } from "@sojourn/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "fixtures", "sample-messages.json");
const fixtureRaw = readFileSync(fixturePath, "utf8");
const fixtureMessages = JSON.parse(fixtureRaw);

function byNativeUuid(nodes: ChronoNode[], nativeUuid: string): ChronoNode | undefined {
  return nodes.find((n) => n.meta.nativeUuid === nativeUuid);
}

const projectInfo = { root: "/repo/project", name: "project" };

describe("parseOpenCodeMessages", () => {
  it("parses the fixture into an IngestBatch", () => {
    const batch = parseOpenCodeMessages(fixtureMessages, "ses_abc", projectInfo);
    expect(batch).not.toBeNull();
  });

  it("sets session.id and cli to opencode", () => {
    const batch = parseOpenCodeMessages(fixtureMessages, "ses_abc", projectInfo)!;
    expect(batch.session.id).toBe("ses_abc");
    expect(batch.session.cli).toBe("opencode");
  });

  it("sets project from the passed-in project info", () => {
    const batch = parseOpenCodeMessages(fixtureMessages, "ses_abc", projectInfo)!;
    expect(batch.project.root).toBe("/repo/project");
    expect(batch.project.name).toBe("project");
  });

  it("produces one prompt node for the user text message", () => {
    const batch = parseOpenCodeMessages(fixtureMessages, "ses_abc", projectInfo)!;
    const promptNodes = batch.nodes.filter((n) => n.kind === "prompt");
    expect(promptNodes).toHaveLength(1);
    const prompt = promptNodes[0];
    expect(prompt.id).toBe("opencode:prt_1");
    expect(prompt.parentId).toBeNull();
    expect(prompt.meta.nativeUuid).toBe("prt_1");
    expect(prompt.summary.startsWith("Please add a health check endpoint")).toBe(true);
  });

  it("produces one assistant text node and TWO tool nodes as siblings under it (fan-out, not chained)", () => {
    const batch = parseOpenCodeMessages(fixtureMessages, "ses_abc", projectInfo)!;
    const assistantText = byNativeUuid(batch.nodes, "prt_2");
    expect(assistantText).toBeDefined();
    expect(assistantText!.kind).toBe("assistant");
    expect(assistantText!.parentId).toBe("opencode:prt_1");

    const tool1 = byNativeUuid(batch.nodes, "call_read_001");
    const tool2 = byNativeUuid(batch.nodes, "call_read_002");
    expect(tool1).toBeDefined();
    expect(tool2).toBeDefined();
    expect(tool1!.kind).toBe("tool_use");
    expect(tool2!.kind).toBe("tool_use");

    // Sibling / fan-out rule: parallel tool parts share the same parent (the
    // preceding text node), never chained tool-under-tool.
    expect(tool1!.parentId).toBe(assistantText!.id);
    expect(tool2!.parentId).toBe(assistantText!.id);
    expect(tool1!.id).not.toBe(tool2!.id);
  });

  it("keeps all tool siblings (no sibling-drop) and emits a tool_result child for each completed tool", () => {
    const batch = parseOpenCodeMessages(fixtureMessages, "ses_abc", projectInfo)!;
    const toolNodes = batch.nodes.filter((n) => n.kind === "tool_use");
    expect(toolNodes).toHaveLength(2);

    const tool1 = byNativeUuid(batch.nodes, "call_read_001")!;
    const tool2 = byNativeUuid(batch.nodes, "call_read_002")!;
    const result1 = byNativeUuid(batch.nodes, "call_read_001#result");
    const result2 = byNativeUuid(batch.nodes, "call_read_002#result");

    expect(result1).toBeDefined();
    expect(result2).toBeDefined();
    expect(result1!.kind).toBe("tool_result");
    expect(result2!.kind).toBe("tool_result");
    expect(result1!.parentId).toBe(tool1.id);
    expect(result2!.parentId).toBe(tool2.id);

    const resultNodes = batch.nodes.filter((n) => n.kind === "tool_result");
    expect(resultNodes).toHaveLength(2);
  });

  it("tool_use summary prefers the tool's input filePath-like fields", () => {
    const batch = parseOpenCodeMessages(fixtureMessages, "ses_abc", projectInfo)!;
    const tool1 = byNativeUuid(batch.nodes, "call_read_001")!;
    expect(tool1.summary).toContain("/repo/project/src/server.ts");
  });

  it("chains subsequent assistant text nodes across separate messages", () => {
    const batch = parseOpenCodeMessages(fixtureMessages, "ses_abc", projectInfo)!;
    const followUp = byNativeUuid(batch.nodes, "prt_5");
    expect(followUp).toBeDefined();
    expect(followUp!.kind).toBe("assistant");
    // Follows the last node of the prior assistant message (fan-out parent
    // convention): parented to the preceding text node, not a tool node.
    expect(followUp!.parentId).toBe("opencode:prt_2");
    expect(followUp!.summary.length).toBeLessThanOrEqual(120);
  });

  it("skips part types it doesn't model (e.g. step-start) without crashing", () => {
    const batch = parseOpenCodeMessages(fixtureMessages, "ses_abc", projectInfo)!;
    expect(byNativeUuid(batch.nodes, "prt_6")).toBeUndefined();
  });

  it("every node id follows the opencode:<nativeUuid> convention", () => {
    const batch = parseOpenCodeMessages(fixtureMessages, "ses_abc", projectInfo)!;
    for (const node of batch.nodes) {
      expect(node.id).toBe(`opencode:${node.meta.nativeUuid}`);
      expect(node.cli).toBe("opencode");
      expect(node.sessionId).toBe("ses_abc");
    }
  });

  it("is idempotent: re-parsing the same messages yields the same ids, kinds, and parent links", () => {
    const batch1 = parseOpenCodeMessages(fixtureMessages, "ses_abc", projectInfo)!;
    const batch2 = parseOpenCodeMessages(fixtureMessages, "ses_abc", projectInfo)!;
    const shape = (b: typeof batch1) =>
      b.nodes.map((n) => ({ id: n.id, parentId: n.parentId, kind: n.kind }));
    expect(shape(batch1)).toEqual(shape(batch2));
  });

  it("returns null for an empty messages array", () => {
    const batch = parseOpenCodeMessages([], "ses_abc", projectInfo);
    expect(batch).toBeNull();
  });

  it("never throws: skips malformed message entries", () => {
    const malformed = [
      null,
      42,
      { info: { id: "bad" } }, // no parts
      { info: { id: "msg_ok", role: "user", sessionID: "ses_abc" }, parts: "not-an-array" },
    ];
    expect(() => parseOpenCodeMessages(malformed as any, "ses_abc", projectInfo)).not.toThrow();
    const batch = parseOpenCodeMessages(malformed as any, "ses_abc", projectInfo);
    expect(batch).toBeNull();
  });

  it("skips tool parts lacking a callID (can't address them) without crashing", () => {
    const messages = [
      {
        info: { id: "msg_x", role: "assistant", sessionID: "ses_abc" },
        parts: [{ id: "prt_x", messageID: "msg_x", sessionID: "ses_abc", type: "tool" }],
      },
    ];
    expect(() => parseOpenCodeMessages(messages, "ses_abc", projectInfo)).not.toThrow();
    const batch = parseOpenCodeMessages(messages, "ses_abc", projectInfo);
    expect(batch).toBeNull();
  });
});
