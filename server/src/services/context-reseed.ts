/**
 * Bounded re-seed for context-window overflows.
 *
 * A context-window overflow ("400 invalid params, context window exceeds
 * limit (2013)") is a property of the ACCUMULATED context, not of the
 * transport. The bounded transient retry ladder replays the same issue
 * context on every attempt, so an attempt that overflows dies identically
 * again - the retry ladder turns one overflow into five.
 *
 * The fix is not "retry harder": it is "retry with a SMALLER prompt".
 * When a run fails with the distinct overflow code (`acpx_transient_upsert`),
 * the scheduled retry carries a re-seed directive in its context snapshot.
 * The next attempt reads that directive and rebuilds the prompt from a
 * BOUNDED context instead of the full one:
 *
 *   - the issue description is truncated to a fixed budget,
 *   - the ancestor chain is reduced to the nearest few entries,
 *   - the continuation summary is truncated (it is an unbounded document),
 *   - the ACP session is dropped, so the transcript is not replayed.
 *
 * Everything here is pure so it can be unit-tested without a database.
 */

export const CONTEXT_RESEED_KEY = "contextReseed";

export const CONTEXT_RESEED_REASON = "context_overflow";

/**
 * The re-seed reason for a TRANSCRIPT overflow (TON-1001).
 *
 * A transcript overflow is not an oversized prompt: the prompt was fine and
 * the attempt's own accumulated ACP transcript grew past the window. The
 * retry therefore needs the same treatment (a fresh session and a bounded
 * context) but a different label, so the run history can tell the two
 * causes apart.
 */
export const CONTEXT_RESEED_REASON_TRANSCRIPT_OVERFLOW = "transcript_overflow";

/** Budget for the issue description in a re-seeded prompt. */
export const CONTEXT_RESEED_MAX_DESCRIPTION_CHARS = 4_000;

/** Budget for the continuation summary in a re-seeded prompt. */
export const CONTEXT_RESEED_MAX_CONTINUATION_SUMMARY_CHARS = 4_000;

/** How many ancestor entries survive into a re-seeded prompt. */
export const CONTEXT_RESEED_MAX_ANCESTORS = 2;

export type ContextReseedDirective = {
  reason: string;
  sourceRunId: string | null;
  attempt: number | null;
  partialProgress: string | null;
};

export type BoundedText = {
  text: string | null;
  truncated: boolean;
  originalLength: number;
};

function parseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

/**
 * Read the re-seed directive from a run's context snapshot.
 *
 * Returns null when the run is NOT a re-seed attempt, which is the normal
 * case: only a retry scheduled after a context-window overflow carries one.
 */
export function readContextReseedDirective(context: unknown): ContextReseedDirective | null {
  const raw = parseObject(parseObject(context)[CONTEXT_RESEED_KEY]);
  if (Object.keys(raw).length === 0) return null;
  const reason = readNonEmptyString(raw.reason) ?? CONTEXT_RESEED_REASON;
  return {
    reason,
    sourceRunId: readNonEmptyString(raw.sourceRunId),
    attempt: asPositiveInt(raw.attempt),
    partialProgress: readNonEmptyString(raw.partialProgress),
  };
}

/**
 * Build the context-snapshot patch that marks a scheduled retry as a
 * re-seed attempt. The retry inherits the source run's context snapshot, so
 * the directive travels with it into the next attempt.
 */
export function buildContextReseedSnapshot(input: {
  sourceRunId: string;
  attempt?: number | null;
  reason?: string;
  partialProgress?: string | null;
}): Record<string, unknown> {
  return {
    [CONTEXT_RESEED_KEY]: {
      reason: input.reason ?? CONTEXT_RESEED_REASON,
      sourceRunId: input.sourceRunId,
      attempt: input.attempt ?? null,
      ...(input.partialProgress ? { partialProgress: input.partialProgress } : {}),
    },
  };
}

/**
 * Truncate a text to a character budget. The result says whether anything
 * was dropped, so callers can tell the agent that the text is partial
 * instead of silently presenting a truncated body as the whole thing.
 */
export function boundText(value: string | null | undefined, maxChars: number): BoundedText {
  const text = typeof value === "string" ? value : "";
  const limit = Math.max(0, Math.floor(maxChars));
  if (text.length <= limit) {
    return { text: text.length ? text : null, truncated: false, originalLength: text.length };
  }
  return {
    text: text.slice(0, limit),
    truncated: true,
    originalLength: text.length,
  };
}

/**
 * Bound the issue description for a re-seeded prompt.
 */
export function boundIssueDescription(
  description: string | null | undefined,
  maxChars: number = CONTEXT_RESEED_MAX_DESCRIPTION_CHARS,
): BoundedText {
  return boundText(description, maxChars);
}

/**
 * Bound the continuation summary for a re-seeded prompt. The summary is an
 * arbitrary-length document, so it is the most likely single contributor to
 * an overflow.
 */
export function boundContinuationSummary(
  body: string | null | undefined,
  maxChars: number = CONTEXT_RESEED_MAX_CONTINUATION_SUMMARY_CHARS,
): BoundedText {
  return boundText(body, maxChars);
}

/**
 * Reduce the ancestor chain to the nearest few entries. The chain is
 * rebuilt from the issue's parents on every attempt, so it is re-injected on
 * every retry unless it is bounded.
 */
export function boundAncestors<T>(ancestors: T[] | null | undefined, max: number = CONTEXT_RESEED_MAX_ANCESTORS): T[] {
  const list = Array.isArray(ancestors) ? ancestors : [];
  const limit = Math.max(0, Math.floor(max));
  return list.slice(0, limit);
}

/**
 * The note appended to a re-seeded prompt so the agent knows the context it
 * received is partial, and that the authoritative state lives on the issue.
 */
export const CONTEXT_RESEED_NOTE =
  "This prompt was re-seeded after a context-window overflow: the previous attempt's context was too large to fit. " +
  "The issue description, ancestor chain and continuation summary above may be truncated. " +
  "Read the issue thread for the authoritative state before acting.";

/**
 * The header for the partial progress a stopped attempt left behind.
 *
 * TON-1001: an attempt can be stopped because its OWN transcript grew past
 * the context window. The work it did is not lost - it is carried here as
 * durable state, so the next attempt resumes from the progress instead of
 * from the transcript that overflowed.
 */
export const CONTEXT_RESEED_PARTIAL_PROGRESS_PREFIX =
  "The previous attempt was stopped before it could overflow: its own accumulated transcript " +
  "grew past the context window. Its partial progress follows - resume from it rather than " +
  "re-doing the work, and keep this attempt's own transcript small (checkpoint progress to the " +
  "issue as you go).";

export type ReseedInputs = {
  description: string | null | undefined;
  ancestors: unknown[];
  continuationSummaryBody: string | null | undefined;
};

export type BoundedReseedInputs = {
  description: string | null;
  ancestors: unknown[];
  continuationSummaryBody: string | null;
  truncated: boolean;
};

/**
 * Apply the re-seed budgets to the three unbounded inputs of a prompt.
 *
 * Returns the bounded values plus a `truncated` flag so the caller can tell
 * the agent that what it received is partial.
 */
export function boundReseedInputs(input: ReseedInputs): BoundedReseedInputs {
  const description = boundIssueDescription(input.description);
  const ancestors = boundAncestors(input.ancestors);
  const summary = boundContinuationSummary(input.continuationSummaryBody);
  return {
    description: description.text,
    ancestors,
    continuationSummaryBody: summary.text,
    truncated: description.truncated || summary.truncated || ancestors.length < (input.ancestors?.length ?? 0),
  };
}
