import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const data = parseObject(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const name = asString(rec.name, "").trim();
  if (name) return name;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

const OPEN_CODE_QUOTA_ERROR_TYPE_RE = /^provider\.quota$/i;
const OPEN_CODE_QUOTA_MESSAGE_RE =
  /(?:freeusagelimiterror|usage\s*limit|rate\s*limit|too\s*many\s+requests|\b429\b|quota\s*exceeded|exceeded\s+the\s+(?:models?|usage)\s+(?:quota|limit)|billing\s+detail)/i;

/**
 * Detect an upstream provider quota / rate-limit condition from an OpenCode
 * `error` event. OpenCode surfaces these as `{ type: "provider.quota", status: 429,
 * message: "Rate limit exceeded…" }`, often with a nested provider body such as
 * `FreeUsageLimitError`. Classifying them (instead of a generic adapter failure)
 * lets the heartbeat service apply provider-quota backoff rather than treating
 * every occurrence as a hard failure.
 */
function isQuotaErrorEvent(error: unknown): boolean {
  const rec = parseObject(error);
  const type = asString(rec.type, "").trim();
  if (OPEN_CODE_QUOTA_ERROR_TYPE_RE.test(type)) return true;
  const status = asNumber(rec.status, 0);
  if (status === 429) return true;
  const message = errorText(error);
  if (message && OPEN_CODE_QUOTA_MESSAGE_RE.test(message)) return true;
  const response = parseObject(rec.response);
  const body = asString(response.body, "").trim();
  return Boolean(body && OPEN_CODE_QUOTA_MESSAGE_RE.test(body));
}

export function parseOpenCodeJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const toolErrors: string[] = [];
  let quotaExceeded = false;
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const currentSessionId = asString(event.sessionID, "").trim();
    if (currentSessionId) sessionId = currentSessionId;

    const type = asString(event.type, "");

    if (type === "text") {
      const part = parseObject(event.part);
      const text = asString(part.text, "").trim();
      if (text) messages.push(text);
      continue;
    }

    if (type === "step_finish") {
      const part = parseObject(event.part);
      const tokens = parseObject(part.tokens);
      const cache = parseObject(tokens.cache);
      usage.inputTokens += asNumber(tokens.input, 0);
      usage.cachedInputTokens += asNumber(cache.read, 0);
      usage.outputTokens += asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0);
      costUsd += asNumber(part.cost, 0);
      continue;
    }

    if (type === "tool_use") {
      const part = parseObject(event.part);
      const state = parseObject(part.state);
      if (asString(state.status, "") === "error") {
        const text = asString(state.error, "").trim();
        if (text) toolErrors.push(text);
      }
      continue;
    }

    if (type === "error") {
      const errorPayload = event.error ?? event.message;
      const text = errorText(errorPayload).trim();
      if (text) errors.push(text);
      if (isQuotaErrorEvent(errorPayload)) quotaExceeded = true;
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
    toolErrors,
    quotaExceeded,
  };
}

/**
 * Fallback quota detection for non-JSONL output (e.g. plain stderr). OpenCode
 * quota failures may surface only as free text when the JSONL stream is not
 * produced, so scan stderr/stdout before giving up.
 */
export function isOpenCodeQuotaError(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const haystack = [input.stdout, input.stderr, input.errorMessage]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
  return Boolean(haystack) && OPEN_CODE_QUOTA_MESSAGE_RE.test(haystack);
}

export function isOpenCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|resource\s+not\s+found:.*[\\/]session[\\/].*\.json|notfounderror|no session/i.test(
    haystack,
  );
}
