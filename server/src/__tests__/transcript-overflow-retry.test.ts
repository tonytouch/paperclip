import { describe, expect, it } from "vitest";
import { classifyContinuationFailure } from "../services/recovery/service.js";
import { readHeartbeatRunErrorFamily } from "../services/run-error-family.js";
import {
  CONTEXT_RESEED_PARTIAL_PROGRESS_PREFIX,
  CONTEXT_RESEED_REASON_TRANSCRIPT_OVERFLOW,
  buildContextReseedSnapshot,
  readContextReseedDirective,
} from "../services/context-reseed.js";

/**
 * TON-1001: TON-868 stopped the REPLAY of an oversized prompt. It did not
 * bound the TRANSCRIPT a single attempt accumulates while it works, so a
 * 43-minute attempt could still grow its own ACP conversation past the
 * context window and die with the same 2013 refusal.
 *
 * The attempt is now stopped BEFORE the provider refuses, and the stop
 * carries its own error code so the two causes can be routed apart:
 *
 *   - `acpx_transient_upsert`              the PROMPT was too big to send.
 *   - `acpx_transient_transcript_overflow` the attempt's own transcript grew
 *                                          past the window.
 *
 * These tests pin the routing contract for the second code.
 */
const TRANSCRIPT_OVERFLOW_CODE = "acpx_transient_transcript_overflow";

describe("the transcript overflow is routed as a transient upstream failure", () => {
  it("keeps the transient-upstream family so the bounded retry ladder engages", () => {
    expect(
      readHeartbeatRunErrorFamily({
        errorCode: TRANSCRIPT_OVERFLOW_CODE,
        error: "Attempt stopped before the context window overflowed",
        resultJson: null,
      }),
    ).toBe("transient_upstream");
  });

  it("is treated as a transient infra failure by the continuation ladder", () => {
    const classification = classifyContinuationFailure({
      id: "run-1",
      agentId: "agent-1",
      status: "failed",
      error: "Attempt stopped before the context window overflowed",
      errorCode: TRANSCRIPT_OVERFLOW_CODE,
      contextSnapshot: null,
      livenessState: null,
    });
    expect(classification.kind).toBe("transient_infra");
    expect(classification.errorCode).toBe(TRANSCRIPT_OVERFLOW_CODE);
  });
});

describe("the transcript overflow retry carries the stopped attempt's progress", () => {
  it("marks the retry as a transcript re-seed, distinct from a prompt re-seed", () => {
    const snapshot = buildContextReseedSnapshot({
      sourceRunId: "run-1",
      attempt: 2,
      reason: CONTEXT_RESEED_REASON_TRANSCRIPT_OVERFLOW,
      partialProgress: "the work already done",
    });
    const directive = readContextReseedDirective(snapshot);
    expect(directive?.reason).toBe(CONTEXT_RESEED_REASON_TRANSCRIPT_OVERFLOW);
    expect(directive?.reason).not.toBe("context_overflow");
  });

  it("names the partial progress in the prompt so the next attempt resumes from it", () => {
    expect(CONTEXT_RESEED_PARTIAL_PROGRESS_PREFIX).toContain("partial progress");
    expect(CONTEXT_RESEED_PARTIAL_PROGRESS_PREFIX).toContain("resume from it");
  });
});
