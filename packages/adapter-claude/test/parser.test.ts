import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseSessionJsonl, claudeProjectsDir, watchGlob } from "../src/index.js";
import type { ChronoNode } from "@sojourn/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "fixtures", "sample-session.jsonl");
const fixtureRaw = readFileSync(fixturePath, "utf8");

function byNativeUuid(nodes: ChronoNode[], nativeUuid: string): ChronoNode | undefined {
  return nodes.find((n) => n.meta.nativeUuid === nativeUuid);
}

describe("parseSessionJsonl", () => {
  it("parses the fixture into an IngestBatch", () => {
    const batch = parseSessionJsonl(fixturePath, fixtureRaw);
    expect(batch).not.toBeNull();
  });

  it("sets project.root to the most common cwd in the file", () => {
    const batch = parseSessionJsonl(fixturePath, fixtureRaw)!;
    expect(batch.project.root).toBe("/repo/project");
  });

  it("sets session.id to the file's sessionId and cli to claude", () => {
    const batch = parseSessionJsonl(fixturePath, fixtureRaw)!;
    expect(batch.session.id).toBe("session-abc");
    expect(batch.session.cli).toBe("claude");
  });

  it("falls back to the file basename for session id when sessionId is absent", () => {
    const raw = [
      JSON.stringify({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        cwd: "/repo",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "hi" },
      }),
    ].join("\n");
    const fp = "/tmp/some-dir/abc-session-id.jsonl";
    const batch = parseSessionJsonl(fp, raw)!;
    expect(batch.session.id).toBe("abc-session-id");
  });

  it("produces one prompt node for the user text line", () => {
    const batch = parseSessionJsonl(fixturePath, fixtureRaw)!;
    const promptNodes = batch.nodes.filter((n) => n.kind === "prompt");
    expect(promptNodes).toHaveLength(1);
    const prompt = promptNodes[0];
    expect(prompt.id).toBe("claude:11111111-1111-1111-1111-111111111111");
    expect(prompt.parentId).toBeNull();
    expect(prompt.meta.nativeUuid).toBe("11111111-1111-1111-1111-111111111111");
    expect(prompt.summary.startsWith("Please add a health check endpoint")).toBe(true);
  });

  it("produces one assistant text node and TWO tool_use nodes as siblings under the same parent", () => {
    const batch = parseSessionJsonl(fixturePath, fixtureRaw)!;
    const assistantText = byNativeUuid(batch.nodes, "22222222-2222-2222-2222-222222222222");
    expect(assistantText).toBeDefined();
    expect(assistantText!.kind).toBe("assistant");
    expect(assistantText!.parentId).toBe("claude:11111111-1111-1111-1111-111111111111");

    const toolUse1 = byNativeUuid(batch.nodes, "toolu_read_001");
    const toolUse2 = byNativeUuid(batch.nodes, "toolu_read_002");
    expect(toolUse1).toBeDefined();
    expect(toolUse2).toBeDefined();
    expect(toolUse1!.kind).toBe("tool_use");
    expect(toolUse2!.kind).toBe("tool_use");

    // Sibling rule: subsequent blocks parent to the previous block's node.
    // Block order: text(uuid) -> tool_use(001) -> tool_use(002)
    expect(toolUse1!.parentId).toBe(assistantText!.id);
    expect(toolUse2!.parentId).toBe(toolUse1!.id);
  });

  it("parents each tool_result to its own tool_use node via tool_use_id, keeping both siblings", () => {
    const batch = parseSessionJsonl(fixturePath, fixtureRaw)!;
    const toolUse1 = byNativeUuid(batch.nodes, "toolu_read_001")!;
    const toolUse2 = byNativeUuid(batch.nodes, "toolu_read_002")!;

    const result1 = byNativeUuid(batch.nodes, "33333333-3333-3333-3333-333333333333");
    const result2 = byNativeUuid(batch.nodes, "44444444-4444-4444-4444-444444444444");

    expect(result1).toBeDefined();
    expect(result2).toBeDefined();
    expect(result1!.kind).toBe("tool_result");
    expect(result2!.kind).toBe("tool_result");

    // Each tool_result parents to its OWN tool_use, not to each other or dropped.
    expect(result1!.parentId).toBe(toolUse1.id);
    expect(result2!.parentId).toBe(toolUse2.id);

    // Both siblings must be present (no sibling-drop bug).
    const toolResultNodes = batch.nodes.filter((n) => n.kind === "tool_result");
    expect(toolResultNodes).toHaveLength(2);
  });

  it("handles a tool_result whose content is an array of blocks", () => {
    const batch = parseSessionJsonl(fixturePath, fixtureRaw)!;
    const result2 = byNativeUuid(batch.nodes, "44444444-4444-4444-4444-444444444444")!;
    expect(result2.kind).toBe("tool_result");
  });

  it("produces the follow-up assistant text node parented to the correct prior node", () => {
    const batch = parseSessionJsonl(fixturePath, fixtureRaw)!;
    const followUp = byNativeUuid(batch.nodes, "55555555-5555-5555-5555-555555555555");
    expect(followUp).toBeDefined();
    expect(followUp!.kind).toBe("assistant");
    expect(followUp!.parentId).toBe("claude:44444444-4444-4444-4444-444444444444");
    // summary = first 120 chars of text
    expect(followUp!.summary.length).toBeLessThanOrEqual(120);
  });

  it("skips malformed lines and summary/system/isSidechain lines without crashing", () => {
    const batch = parseSessionJsonl(fixturePath, fixtureRaw)!;
    // Total real nodes: prompt(1) + assistant text(1) + tool_use(2) + tool_result(2) + assistant text(1) = 7
    expect(batch.nodes).toHaveLength(7);
    // No node should carry the sidechain uuid or the summary line's data.
    expect(byNativeUuid(batch.nodes, "77777777-7777-7777-7777-777777777777")).toBeUndefined();
    expect(byNativeUuid(batch.nodes, "66666666-6666-6666-6666-666666666666")).toBeUndefined();
  });

  it("every node id follows the claude:<nativeUuid> convention", () => {
    const batch = parseSessionJsonl(fixturePath, fixtureRaw)!;
    for (const node of batch.nodes) {
      expect(node.id).toBe(`claude:${node.meta.nativeUuid}`);
      expect(node.cli).toBe("claude");
      expect(node.sessionId).toBe("session-abc");
    }
  });

  it("is idempotent: re-parsing the same raw text yields the same ids, kinds, and parent links", () => {
    const batch1 = parseSessionJsonl(fixturePath, fixtureRaw)!;
    const batch2 = parseSessionJsonl(fixturePath, fixtureRaw)!;
    const shape = (b: typeof batch1) =>
      b.nodes.map((n) => ({ id: n.id, parentId: n.parentId, kind: n.kind }));
    expect(shape(batch1)).toEqual(shape(batch2));
  });

  it("returns null for empty raw content", () => {
    const batch = parseSessionJsonl(fixturePath, "");
    expect(batch).toBeNull();
  });

  it("returns null when every line is malformed or skippable (no usable nodes)", () => {
    const raw = [
      "not json at all",
      JSON.stringify({ type: "summary", summary: "x", leafUuid: "a", sessionId: "s" }),
      JSON.stringify({
        type: "system",
        uuid: "sys-1",
        parentUuid: null,
        cwd: "/repo",
        timestamp: "2026-01-01T00:00:00.000Z",
        content: "hi",
      }),
    ].join("\n");
    const batch = parseSessionJsonl(fixturePath, raw);
    expect(batch).toBeNull();
  });

  it("does not crash on trailing blank lines", () => {
    const raw = fixtureRaw + "\n\n\n";
    expect(() => parseSessionJsonl(fixturePath, raw)).not.toThrow();
  });
});

describe("claudeProjectsDir", () => {
  const originalEnv = process.env.CLAUDE_CONFIG_DIR;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalEnv;
  });

  it("defaults to ~/.claude/projects when CLAUDE_CONFIG_DIR is unset", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    const dir = claudeProjectsDir();
    expect(dir.endsWith(path.join(".claude", "projects"))).toBe(true);
  });

  it("honors CLAUDE_CONFIG_DIR when set", () => {
    process.env.CLAUDE_CONFIG_DIR = "/custom/config/dir";
    const dir = claudeProjectsDir();
    expect(dir).toBe(path.join("/custom/config/dir", "projects"));
  });
});

describe("watchGlob", () => {
  it("returns a glob rooted at claudeProjectsDir matching **/*.jsonl", () => {
    const glob = watchGlob();
    expect(glob).toBe(path.join(claudeProjectsDir(), "**", "*.jsonl"));
  });
});
