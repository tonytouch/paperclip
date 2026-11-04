/**
 * Bounding a single ACPX attempt so its OWN transcript cannot overflow the
 * provider's context window.
 *
 * TON-868 stopped the REPLAY of an oversized prompt: it gave the overflow its
 * own error code and re-seeded the retry with a bounded context. It did NOT
 * bound the transcript a single attempt accumulates while it works. A
 * 43-minute attempt on the CTO seat grew its ACP conversation to ~670 KB of
 * assistant content (and ~11.8 M cumulative cache-read tokens) and died with
 * the same "context window exceeds limit (2013)" refusal.
 *
 * Both causes surface as one error, so the two cannot be routed apart. This
 * module separates them:
 *
 *   - `acpx_transient_upsert`            the PROMPT was too big to send.
 *   - `acpx_transient_transcript_overflow` the attempt's own accumulated
 *     transcript grew past what the provider's window can hold.
 *
 * The second code is ALSO the preemptive stop: when an attempt crosses the
 * transcript budget it is cancelled and reported with this code, so the run
 * ends in a retryable stop instead of a 2013 death.
 *
 * Everything here is pure so it can be unit-tested without a runtime.
 */

import {
  CONTEXT_OVERFLOW_ERROR_CODE,
  CONTEXT_OVERFLOW_ERROR_FAMILY,
} from "./context-overflow.js";

/**
 * The error code for an overflow caused by the attempt's own transcript.
 * Distinct from `acpx_transient_upsert` (an oversized PROMPT) so the two
 * causes can be told apart in the run history.
 */
export const TRANSCRIPT_OVERFLOW_ERROR_CODE = "acpx_transient_transcript_overflow" as const;

/** The family stays `transient_upstream`: a retry on a fresh session recovers. */
export const TRANSCRIPT_OVERFLOW_ERROR_FAMILY: typeof CONTEXT_OVERFLOW_ERROR_FAMILY =
  CONTEXT_OVERFLOW_ERROR_FAMILY;

/**
 * Characters of assistant-produced content one attempt may accumulate before
 * it is stopped as a runaway.
 *
 * This is a BACKSTOP, not the primary bound: the primary bound is the
 * agent's own reported context occupancy (`DEFAULT_CONTEXT_USAGE_STOP_RATIO`),
 * which measures the thing the provider actually refuses on.
 *
 * The char budget is calibrated from the CTO seat's own ACP session records
 * (214 single-attempt sessions, assistant content measured on the persisted
 * `Agent` message): median 460 127 chars, p90 788 003, max 1 162 633. A
 * fatal 43-minute attempt on that seat sat at 671 436 chars - BELOW the p90 -
 * so char count ALONE does not predict the refusal, and a budget set near the
 * fatal size would stop healthy long attempts instead. The budget is
 * therefore set ABOVE every transcript the seat has produced, so it fires
 * only on a genuine runaway and never pre-empts a working attempt.
 *
 * The persisted session understates the real context (it holds the
 * assistant's text, tool inputs and thinking, but not the tool results the
 * provider replays), which is another reason the occupancy ratio - not this
 * number - is what actually stops an attempt in time.
 *
 * MEASURED on the fatal attempt itself (run `3bda93a1-6432-45bc-bebc-b65eb4f857a0`,
 * 2026-11-03), from its persisted run NDJSON:
 *
 *   - prompt: 3 063 chars of task markdown (whole context snapshot 21 382) -
 *     the prompt was never the problem;
 *   - transcript: 526 754 chars (476 119 text + 50 635 tool) - below the
 *     p90 above, and below this backstop, so the CHAR bound alone would NOT
 *     have stopped it;
 *   - reported occupancy: 37 333 -> 208 538 / 200 000 (ratio 1.04) over the
 *     42.9 minutes, crossing 0.85 at 03:22:02 - 9.5 minutes BEFORE the
 *     2013 at 03:31:41.
 *
 * So the OCCUPANCY ratio is what stops the attempt in time, and the char
 * budget is the backstop for a runtime that reports no occupancy at all.
 */
export const DEFAULT_TRANSCRIPT_BUDGET_CHARS = 1_200_000;

/**
 * Characters of prompt above which the PROMPT is the overflowing cause.
 *
 * TON-868's re-seed caps each context component at 4 000 chars, so a
 * re-seeded prompt is ~10 KB and never reaches this. A prompt this large is
 * an oversized-replay problem, which is what `acpx_transient_upsert` means.
 */
export const DEFAULT_PROMPT_BUDGET_CHARS = 40_000;

/**
 * Fraction of the provider's reported context window at which the attempt is
 * stopped. The agent reports its own occupancy through the ACP `usage_update`
 * event, so this bound follows the model instead of assuming a window size.
 */
export const DEFAULT_CONTEXT_USAGE_STOP_RATIO = 0.85;

/**
 * Reported context occupancy at or above which a 2013 refusal is attributed
 * to the attempt's own transcript rather than to its prompt.
 *
 * Lower than the preemptive stop ratio because the occupancy the agent last
 * reported is one turn stale: the refusal happened on a LATER request, so the
 * window was fuller than the last report showed.
 */
export const CONTEXT_OVERFLOW_TRANSCRIPT_OCCUPANCY_RATIO = 0.6;

/** The agent's reported context occupancy, in tokens. */
export type ContextUsageSample = {
  used: number;
  size: number;
};

export type ContextOverflowCause = "prompt" | "transcript";

export type ContextOverflowClassification = {
  errorCode: string;
  errorFamily: typeof CONTEXT_OVERFLOW_ERROR_FAMILY;
  cause: ContextOverflowCause;
};

/** A preemptive stop of an attempt that would otherwise overflow. */
export type TranscriptStop = {
  message: string;
  detail: Record<string, unknown>;
};

/**
 * Read the context occupancy an agent reports through the ACP `usage_update`
 * event. Returns null when the event carries no usable occupancy - the
 * transcript-bytes budget is the fallback bound.
 */
export function readContextUsageSample(event: {
  tag?: string | null;
  used?: number | null;
  size?: number | null;
} | null | undefined): ContextUsageSample | null {
  if (!event) return null;
  if (event.tag !== "usage_update") return null;
  const used = typeof event.used === "number" && Number.isFinite(event.used) ? event.used : null;
  const size = typeof event.size === "number" && Number.isFinite(event.size) ? event.size : null;
  if (used === null || size === null) return null;
  if (size <= 0 || used < 0) return null;
  return { used, size };
}

/**
 * Keep the sample with the HIGHEST occupancy, not the most recent one.
 *
 * The ACP `usage_update` stream interleaves resets: a task-notification turn
 * reports `0/200000` even while the conversation is nearly full. The fatal
 * 43-minute attempt ended on exactly such a reset - its last event was
 * `0/200000` six seconds before the 2013 - so a "last sample wins" tracker
 * would report an empty window, never trip the stop ratio, and misclassify a
 * transcript overflow as a prompt overflow.
 *
 * Occupancy only grows within an attempt, so the maximum is the honest
 * reading of "how full was the window".
 */
export function mergeContextUsageSample(
  current: ContextUsageSample | null,
  next: ContextUsageSample | null,
): ContextUsageSample | null {
  if (!next) return current;
  if (!current) return next;
  return next.used / next.size > current.used / current.size ? next : current;
}

/**
 * True when the reported occupancy has crossed the stop ratio.
 */
export function evaluateContextUsageBudget(
  sample: ContextUsageSample,
  ratio: number = DEFAULT_CONTEXT_USAGE_STOP_RATIO,
): { exceeded: boolean; ratio: number } {
  const limit = Number.isFinite(ratio) && ratio > 0 ? ratio : DEFAULT_CONTEXT_USAGE_STOP_RATIO;
  const observed = sample.used / sample.size;
  return { exceeded: observed >= limit, ratio: observed };
}

/**
 * Characters of assistant-produced content in one `tool_call` event.
 *
 * The tool call's input, output and content all land in the assistant
 * message the provider replays on every subsequent request, so they all count
 * against the window.
 */
export function measureToolOutputChars(event: unknown): number {
  if (!event || typeof event !== "object") return 0;
  const record = event as Record<string, unknown>;
  if (record.type !== "tool_call") return 0;
  let total = 0;
  for (const key of ["rawOutput", "content", "rawInput", "text"]) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    total += typeof value === "string" ? value.length : (JSON.stringify(value)?.length ?? 0);
  }
  return total;
}

/**
 * Characters one ACP runtime event adds to the attempt's transcript.
 *
 * Both the assistant's own output and a tool call's input/output land in the
 * conversation the provider replays on every subsequent request, so both
 * count against the window.
 */
export function measureTranscriptEventChars(event: unknown): number {
  if (!event || typeof event !== "object") return 0;
  const record = event as Record<string, unknown>;
  if (record.type === "text_delta") {
    return typeof record.text === "string" ? record.text.length : 0;
  }
  return measureToolOutputChars(event);
}

/**
 * Decide whether an attempt must be stopped before it overflows.
 *
 * Two independent bounds, whichever trips first:
 *   - the transcript character budget (always available), and
 *   - the agent's own reported context occupancy (model-aware).
 */
export function evaluateTranscriptBudget(input: {
  transcriptChars: number;
  transcriptBudgetChars?: number;
  usage?: ContextUsageSample | null;
  usageRatio?: number;
}): { stop: boolean; reason: "transcript_chars" | "context_usage" | null } {
  const budget = input.transcriptBudgetChars ?? DEFAULT_TRANSCRIPT_BUDGET_CHARS;
  const chars = Math.max(0, Math.floor(input.transcriptChars || 0));
  if (chars >= budget) return { stop: true, reason: "transcript_chars" };
  if (input.usage) {
    const { exceeded } = evaluateContextUsageBudget(input.usage, input.usageRatio);
    if (exceeded) return { stop: true, reason: "context_usage" };
  }
  return { stop: false, reason: null };
}

/**
 * Build the stop record for an attempt that crossed the transcript budget.
 */
export function buildTranscriptStop(input: {
  transcriptChars: number;
  reason: "transcript_chars" | "context_usage";
  transcriptBudgetChars?: number;
  usage?: ContextUsageSample | null;
  usageRatio?: number;
}): TranscriptStop {
  const budget = input.transcriptBudgetChars ?? DEFAULT_TRANSCRIPT_BUDGET_CHARS;
  const detail: Record<string, unknown> = {
    cause: "transcript",
    reason: input.reason,
    transcriptChars: input.transcriptChars,
    transcriptBudgetChars: budget,
  };
  if (input.usage) {
    detail.contextUsedTokens = input.usage.used;
    detail.contextWindowTokens = input.usage.size;
    detail.contextUsageRatio = Number(
      (evaluateContextUsageBudget(input.usage, input.usageRatio).ratio).toFixed(4),
    );
  }
  const message =
    input.reason === "context_usage"
      ? `Attempt stopped before the context window overflowed: the agent reported ${input.usage?.used}/${input.usage?.size} tokens in use, which crossed the stop ratio. The attempt's partial progress is preserved; the retry starts on a fresh session.`
      : `Attempt stopped before the context window overflowed: the attempt accumulated ${input.transcriptChars} characters of transcript, over the ${budget}-character budget. The attempt's partial progress is preserved; the retry starts on a fresh session.`;
  return { message, detail };
}

/**
 * Classify a context-window overflow by its CAUSE.
 *
 * The prompt is checked first: an oversized prompt is the replay problem
 * `acpx_transient_upsert` already means, and re-seeding is the right fix for
 * it. A transcript that grew past the budget during the attempt is the
 * problem this module exists for, and it gets its own code so the run
 * history can tell the two apart.
 */
export function classifyContextOverflowCause(input: {
  promptChars: number;
  transcriptChars: number;
  promptBudgetChars?: number;
  transcriptBudgetChars?: number;
  usage?: ContextUsageSample | null;
  usageRatio?: number;
}): ContextOverflowClassification {
  const promptBudget = input.promptBudgetChars ?? DEFAULT_PROMPT_BUDGET_CHARS;
  const transcriptBudget = input.transcriptBudgetChars ?? DEFAULT_TRANSCRIPT_BUDGET_CHARS;
  const promptChars = Math.max(0, Math.floor(input.promptChars || 0));
  const transcriptChars = Math.max(0, Math.floor(input.transcriptChars || 0));
  if (promptChars >= promptBudget) {
    return {
      errorCode: CONTEXT_OVERFLOW_ERROR_CODE,
      errorFamily: CONTEXT_OVERFLOW_ERROR_FAMILY,
      cause: "prompt",
    };
  }
  if (transcriptChars >= transcriptBudget) {
    return {
      errorCode: TRANSCRIPT_OVERFLOW_ERROR_CODE,
      errorFamily: TRANSCRIPT_OVERFLOW_ERROR_FAMILY,
      cause: "transcript",
    };
  }
  // The preemptive stop catches most transcript overflows BEFORE the provider
  // refuses, so a 2013 that still arrives with a SMALL prompt was almost
  // certainly the accumulated transcript filling the window. The agent's last
  // reported occupancy confirms it: a window that was already near-full means
  // the content that filled it was the attempt's own work, not the prompt.
  //
  // The threshold is deliberately lower than the preemptive stop ratio: the
  // report is one turn stale, so the occupancy at refusal was higher than the
  // occupancy that was last reported.
  if (input.usage) {
    const observed = evaluateContextUsageBudget(input.usage, input.usageRatio).ratio;
    if (observed >= CONTEXT_OVERFLOW_TRANSCRIPT_OCCUPANCY_RATIO) {
      return {
        errorCode: TRANSCRIPT_OVERFLOW_ERROR_CODE,
        errorFamily: TRANSCRIPT_OVERFLOW_ERROR_FAMILY,
        cause: "transcript",
      };
    }
  }
  return {
    errorCode: CONTEXT_OVERFLOW_ERROR_CODE,
    errorFamily: CONTEXT_OVERFLOW_ERROR_FAMILY,
    cause: "prompt",
  };
}
