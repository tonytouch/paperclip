/**
 * Transport-level upstream interruptions.
 *
 * An upstream HTTP/SSE stream that is cut mid-flight ("Connection closed
 * mid-response", a reset socket, a broken pipe) leaves the request REPLAYABLE:
 * the same prompt normally succeeds on a fresh session within a minute or two.
 * It is not a deterministic protocol fault, so a classifier that misses it
 * reports the run as a hard failure and the heartbeat strands the issue.
 *
 * These patterns are deliberately narrow. Only unambiguous transport signals
 * qualify - a broad pattern (e.g. any "400", any "error") would misclassify a
 * genuinely broken adapter as retryable and loop forever.
 *
 * Capacity signals ("overloaded", "service unavailable") are NOT here: they
 * mean the upstream is busy rather than that the connection broke, and each
 * adapter already has its own capacity/quota vocabulary.
 */
export const TRANSPORT_INTERRUPTION_PATTERNS: readonly RegExp[] = [
  /connection\s+closed\s+mid[- ]response/i,
  /\bsocket\s+hang\s?up\b/i,
  /\beconnreset\b/i,
  /\bepipe\b/i,
  /connection\s+reset\s+by\s+peer/i,
  /premature(?:ly)?\s+clos(?:e|ed|ing)/i,
];

/**
 * True when the text describes a transport-level interruption of an upstream
 * stream, as opposed to a deterministic refusal (auth, validation, quota).
 */
export function isTransportInterruptionMessage(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return TRANSPORT_INTERRUPTION_PATTERNS.some((pattern) => pattern.test(trimmed));
}
