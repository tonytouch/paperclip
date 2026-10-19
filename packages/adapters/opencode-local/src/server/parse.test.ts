import { describe, expect, it } from "vitest";
import { parseOpenCodeJsonl, isOpenCodeUnknownSessionError, isOpenCodeQuotaError } from "./parse.js";

describe("parseOpenCodeJsonl", () => {
  it("parses assistant text, usage, cost, and errors", () => {
    const stdout = [
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Hello from OpenCode" },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "session_123",
        part: {
          reason: "done",
          cost: 0.0025,
          tokens: {
            input: 120,
            output: 40,
            reasoning: 10,
            cache: { read: 20, write: 0 },
          },
        },
      }),
      JSON.stringify({
        type: "error",
        sessionID: "session_123",
        error: { message: "model unavailable" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Hello from OpenCode");
    expect(parsed.usage).toEqual({
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 50,
    });
    expect(parsed.costUsd).toBeCloseTo(0.0025, 6);
    expect(parsed.errorMessage).toContain("model unavailable");
    expect(parsed.toolErrors).toEqual([]);
  });

  it("keeps failed tool calls separate from fatal run errors", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        sessionID: "session_123",
        part: {
          state: {
            status: "error",
            error: "File not found: e2b-adapter-result.txt",
          },
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "session_123",
        part: { text: "Recovered and completed the task" },
      }),
    ].join("\n");

    const parsed = parseOpenCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session_123");
    expect(parsed.summary).toBe("Recovered and completed the task");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.toolErrors).toEqual(["File not found: e2b-adapter-result.txt"]);
  });

  it("detects unknown session errors", () => {
    expect(isOpenCodeUnknownSessionError("Session not found: s_123", "")).toBe(true);
    expect(isOpenCodeUnknownSessionError("", "unknown session id")).toBe(true);
    expect(isOpenCodeUnknownSessionError("all good", "")).toBe(false);
  });
});

describe("parseOpenCodeJsonl quota classification", () => {
  // Real event captured from a failing run (heartbeat_runs cc33d6b0…): OpenCode
  // surfaces the Zen free-tier 429 as a provider.quota error event.
  const quotaEvent = JSON.stringify({
    type: "error",
    timestamp: 1792280059558,
    sessionID: "ses_eb3c8a481ffe40UbTwzxMsucOx",
    error: {
      type: "provider.quota",
      message: "Rate limit exceeded. Please try again later.",
      status: 429,
      response: {
        body: '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}',
      },
    },
  });

  it("flags provider.quota events as quotaExceeded", () => {
    const parsed = parseOpenCodeJsonl(
      [
        JSON.stringify({ type: "step_start", sessionID: "ses_1", part: {} }),
        quotaEvent,
      ].join("\n"),
    );
    expect(parsed.quotaExceeded).toBe(true);
    expect(parsed.errorMessage).toContain("Rate limit exceeded");
  });

  it("does not flag ordinary errors as quota", () => {
    const parsed = parseOpenCodeJsonl(
      JSON.stringify({ type: "error", error: { message: "model unavailable" } }),
    );
    expect(parsed.quotaExceeded).toBe(false);
  });

  it("does not flag a bare 429 status without quota semantics as quota via message-only path", () => {
    // status 429 alone is still a quota signal by design, but a plain message
    // like this must not trip the message regex.
    const parsed = parseOpenCodeJsonl(
      JSON.stringify({ type: "error", error: { message: "model unavailable", status: 500 } }),
    );
    expect(parsed.quotaExceeded).toBe(false);
  });
});

describe("isOpenCodeQuotaError fallback", () => {
  it("detects quota text in stderr when no JSONL is produced", () => {
    expect(
      isOpenCodeQuotaError({ stderr: "Error: FreeUsageLimitError rate limit exceeded", stdout: "" }),
    ).toBe(true);
  });

  it("returns false for empty and non-quota input", () => {
    expect(isOpenCodeQuotaError({ stdout: "", stderr: "", errorMessage: null })).toBe(false);
    expect(isOpenCodeQuotaError({ stderr: "connection refused" })).toBe(false);
  });
});
