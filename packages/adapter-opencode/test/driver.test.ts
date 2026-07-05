import { describe, it, expect, vi } from "vitest";
import { buildResumeCommand, revertTo } from "../src/driver.js";
import type { OpenCodeClient } from "../src/client.js";

describe("buildResumeCommand", () => {
  it("builds an `opencode --session <id>` command", () => {
    expect(buildResumeCommand("ses_abc123")).toBe("opencode --session ses_abc123");
  });
});

describe("revertTo", () => {
  it("delegates to client.revert with the session and message id", async () => {
    const revert = vi.fn(async () => ({ ok: true as const, status: 200, data: {} }));
    const client = { revert } as unknown as OpenCodeClient;

    const result = await revertTo(client, "ses_1", "msg_5");

    expect(revert).toHaveBeenCalledWith("ses_1", "msg_5");
    expect(result.ok).toBe(true);
  });

  it("propagates a failed ClientResult without throwing", async () => {
    const revert = vi.fn(async () => ({ ok: false as const, status: null, error: "network down" }));
    const client = { revert } as unknown as OpenCodeClient;

    const result = await revertTo(client, "ses_1", "msg_5");
    expect(result.ok).toBe(false);
  });
});
