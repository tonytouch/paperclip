import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_USAGE_STOP_RATIO,
  DEFAULT_PROMPT_BUDGET_CHARS,
  DEFAULT_TRANSCRIPT_BUDGET_CHARS,
  TRANSCRIPT_OVERFLOW_ERROR_CODE,
  TRANSCRIPT_OVERFLOW_ERROR_FAMILY,
  buildTranscriptStop,
  classifyContextOverflowCause,
  evaluateContextUsageBudget,
  evaluateTranscriptBudget,
  measureToolOutputChars,
  mergeContextUsageSample,
  readContextUsageSample,
} from "./transcript-budget.js";
import { CONTEXT_OVERFLOW_ERROR_CODE } from "./context-overflow.js";

/**
 * TON-1001: a single long attempt can overflow its OWN ACP transcript. The
 * bound must stop the attempt BEFORE the provider refuses, and the two
 * overflow causes (oversized prompt vs. accumulated transcript) must be
 * distinguishable so they can be routed differently.
 */
describe("readContextUsageSample", () => {
  it("reads the agent's reported context occupancy", () => {
    expect(readContextUsageSample({ tag: "usage_update", used: 170_000, size: 200_000 })).toEqual({
      used: 170_000,
      size: 200_000,
    });
  });

  it("ignores events that carry no usable occupancy", () => {
    expect(readContextUsageSample({ tag: "status_update", used: 1, size: 2 })).toBeNull();
    expect(readContextUsageSample({ tag: "usage_update", used: 1 })).toBeNull();
    expect(readContextUsageSample({ tag: "usage_update", used: 1, size: 0 })).toBeNull();
    expect(readContextUsageSample(null)).toBeNull();
    expect(readContextUsageSample(undefined)).toBeNull();
  });
});

describe("evaluateContextUsageBudget", () => {
  it("flags occupancy at or over the stop ratio", () => {
    expect(evaluateContextUsageBudget({ used: 180_000, size: 200_000 }).exceeded).toBe(true);
    expect(evaluateContextUsageBudget({ used: 100_000, size: 200_000 }).exceeded).toBe(false);
  });

  it("defaults to a conservative stop ratio", () => {
    expect(DEFAULT_CONTEXT_USAGE_STOP_RATIO).toBeLessThan(1);
    expect(evaluateContextUsageBudget({ used: 190_000, size: 200_000 }).exceeded).toBe(true);
  });
});

describe("measureToolOutputChars", () => {
  it("counts the assistant-produced content of a tool call", () => {
    const chars = measureToolOutputChars({
      type: "tool_call",
      title: "read_file",
      rawInput: { path: "a.ts" },
      rawOutput: { content: "x".repeat(100) },
    });
    expect(chars).toBeGreaterThan(100);
  });

  it("ignores non tool-call events", () => {
    expect(measureToolOutputChars({ type: "text_delta", text: "x".repeat(50) })).toBe(0);
    expect(measureToolOutputChars(null)).toBe(0);
  });
});

describe("evaluateTranscriptBudget", () => {
  it("stops an attempt that accumulated past the transcript budget", () => {
    const decision = evaluateTranscriptBudget({
      transcriptChars: DEFAULT_TRANSCRIPT_BUDGET_CHARS + 1,
    });
    expect(decision).toEqual({ stop: true, reason: "transcript_chars" });
  });

  it("stops an attempt whose reported context occupancy crossed the ratio", () => {
    const decision = evaluateTranscriptBudget({
      transcriptChars: 10,
      usage: { used: 190_000, size: 200_000 },
    });
    expect(decision).toEqual({ stop: true, reason: "context_usage" });
  });

  it("lets a small attempt continue", () => {
    expect(evaluateTranscriptBudget({ transcriptChars: 10 })).toEqual({
      stop: false,
      reason: null,
    });
  });
});

describe("buildTranscriptStop", () => {
  it("explains the stop and records the transcript size", () => {
    const stop = buildTranscriptStop({
      transcriptChars: 350_000,
      reason: "transcript_chars",
    });
    expect(stop.message).toContain("350000");
    expect(stop.detail).toMatchObject({
      cause: "transcript",
      reason: "transcript_chars",
      transcriptChars: 350_000,
      transcriptBudgetChars: DEFAULT_TRANSCRIPT_BUDGET_CHARS,
    });
  });

  it("records the context occupancy when the usage bound tripped", () => {
    const stop = buildTranscriptStop({
      transcriptChars: 1000,
      reason: "context_usage",
      usage: { used: 190_000, size: 200_000 },
    });
    expect(stop.detail.contextUsedTokens).toBe(190_000);
    expect(stop.detail.contextWindowTokens).toBe(200_000);
  });
});

describe("classifyContextOverflowCause", () => {
  it("calls an oversized prompt the prompt cause", () => {
    const classified = classifyContextOverflowCause({
      promptChars: DEFAULT_PROMPT_BUDGET_CHARS + 1,
      transcriptChars: 0,
    });
    expect(classified.cause).toBe("prompt");
    expect(classified.errorCode).toBe(CONTEXT_OVERFLOW_ERROR_CODE);
  });

  it("calls a grown transcript the transcript cause", () => {
    const classified = classifyContextOverflowCause({
      promptChars: 10_000,
      transcriptChars: DEFAULT_TRANSCRIPT_BUDGET_CHARS + 1,
    });
    expect(classified.cause).toBe("transcript");
    expect(classified.errorCode).toBe(TRANSCRIPT_OVERFLOW_ERROR_CODE);
    expect(classified.errorCode).not.toBe(CONTEXT_OVERFLOW_ERROR_CODE);
    expect(classified.errorFamily).toBe(TRANSCRIPT_OVERFLOW_ERROR_FAMILY);
  });

  it("defaults to the prompt cause when neither budget was crossed", () => {
    const classified = classifyContextOverflowCause({
      promptChars: 10_000,
      transcriptChars: 1_000,
    });
    expect(classified.cause).toBe("prompt");
    expect(classified.errorCode).toBe(CONTEXT_OVERFLOW_ERROR_CODE);
  });

  it("keeps the transcript cause in the transient_upstream family so the retry ladder engages", () => {
    const classified = classifyContextOverflowCause({
      promptChars: 1_000,
      transcriptChars: 999_999,
    });
    expect(classified.errorFamily).toBe("transient_upstream");
  });
});

describe("classifyContextOverflowCause with a reported occupancy", () => {
  it("calls a 2013 with a small prompt but a near-full window the transcript cause", () => {
    const classified = classifyContextOverflowCause({
      promptChars: 10_000,
      transcriptChars: 500_000,
      usage: { used: 160_000, size: 200_000 },
    });
    expect(classified.cause).toBe("transcript");
    expect(classified.errorCode).toBe(TRANSCRIPT_OVERFLOW_ERROR_CODE);
  });

  it("keeps the prompt cause when the window was nowhere near full", () => {
    const classified = classifyContextOverflowCause({
      promptChars: 10_000,
      transcriptChars: 5_000,
      usage: { used: 10_000, size: 200_000 },
    });
    expect(classified.cause).toBe("prompt");
    expect(classified.errorCode).toBe(CONTEXT_OVERFLOW_ERROR_CODE);
  });

  it("still calls an oversized prompt the prompt cause even with a full window", () => {
    const classified = classifyContextOverflowCause({
      promptChars: DEFAULT_PROMPT_BUDGET_CHARS + 1,
      transcriptChars: 500_000,
      usage: { used: 190_000, size: 200_000 },
    });
    expect(classified.cause).toBe("prompt");
  });
});

describe("mergeContextUsageSample", () => {
  /**
   * TON-1001: the ACP `usage_update` stream interleaves resets - a
   * task-notification turn reports `0/200000` even while the conversation is
   * nearly full. The fatal 43-minute attempt ended on exactly such a reset
   * (its last event was `0/200000`, six seconds before the 2013), so a
   * "last sample wins" tracker would report an empty window: the preemptive
   * stop would never fire and the cause would be misclassified.
   */
  it("keeps the highest occupancy, not the most recent one", () => {
    const merged = mergeContextUsageSample(
      { used: 180_000, size: 200_000 },
      { used: 0, size: 200_000 },
    );
    expect(merged).toEqual({ used: 180_000, size: 200_000 });
  });

  it("adopts a higher occupancy that arrives after a lower one", () => {
    const merged = mergeContextUsageSample(
      { used: 10_000, size: 200_000 },
      { used: 171_825, size: 200_000 },
    );
    expect(merged).toEqual({ used: 171_825, size: 200_000 });
  });

  it("keeps the current sample when the next one is absent", () => {
    const current = { used: 50_000, size: 200_000 };
    expect(mergeContextUsageSample(current, null)).toBe(current);
  });

  it("adopts the first sample when there is no current one", () => {
    const next = { used: 50_000, size: 200_000 };
    expect(mergeContextUsageSample(null, next)).toBe(next);
  });

  it("compares by ratio, so a smaller window does not win on absolute tokens", () => {
    const merged = mergeContextUsageSample(
      { used: 100_000, size: 200_000 }, // ratio 0.5
      { used: 40_000, size: 50_000 }, // ratio 0.8
    );
    expect(merged).toEqual({ used: 40_000, size: 50_000 });
  });
});
