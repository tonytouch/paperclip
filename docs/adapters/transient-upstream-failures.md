---
title: Transient upstream failures
summary: How a dropped upstream connection is classified, retried and recovered
---

A run can die mid-turn because the upstream HTTP/SSE stream was cut before the
response finished. The visible symptom is an error string like:

```
Internal error: API Error: Connection closed mid-response. The response above may be incomplete.
```

This is **not** a quota error and **not** a deterministic fault. The request is
replayable: the same prompt normally succeeds on a fresh session within a
minute or two. It matters because a run that dies this way used to leave the
issue with no live execution path — the heartbeat parked it as `blocked` with
no owner, and the partially-written work was orphaned (the original trigger was
[TON-510](/TON/issues/TON-510), raised as TON-522).

## Root cause (TON-522)

The two Claude engines classified upstream failures with different vocabularies:

| Engine | Classifier | Transport interruption? |
|---|---|---|
| ACPX (`engine: acp`, the default) | `packages/adapter-utils/src/acpx-engine/transient-upstream.ts` | yes (since TON-639) |
| Claude CLI (`engine: cli`) | `packages/adapters/claude-local/src/server/parse.ts` | **no** — only capacity/quota patterns matched |

`isClaudeTransientUpstreamError` matched a capacity regex (`429`, `overloaded`,
`service unavailable`, quota wording). "Connection closed mid-response" matched
none of it, so the CLI engine reported `errorCode: null` and
`errorFamily: null` — a *deterministic* failure. The heartbeat's transient
retry ladder is driven by that family, and the recovery sweep treats a run with
no transient family as a dead end. One dropped connection therefore killed the
whole run with no retry and no owner, and any partial work was left orphaned.

## The fix

1. **Shared vocabulary.** `packages/adapter-utils/src/transient-transport.ts`
   owns the transport-interruption patterns (`TRANSPORT_INTERRUPTION_PATTERNS`,
   `isTransportInterruptionMessage`). Both engines now use it, so
   "Connection closed mid-response" means the same thing on each.
2. **Transport interruptions are transient, capacity-independent.** The CLI
   classifier returns `true` for a transport interruption even though the
   upstream is not busy. The run is then recorded as `errorCode:
   "claude_transient_upstream"`, `errorFamily: "transient_upstream"`, which the
   heartbeat's bounded retry ladder and the recovery continuation budget both
   already understand.
3. **Do not resume a truncated transcript.** A stream cut mid-flight leaves the
   on-disk Claude transcript half-written; resuming it replays the same broken
   exchange. A transport interruption now sets `clearSession: true` on the
   adapter result, so the retry starts from a clean session. The ACPX engine
   already did this; the CLI engine now matches.

Capacity signals ("overloaded", "503") and provider-quota wording are still
classified separately, and deterministic refusals (auth, validation, max
turns) are still *not* transient — the patterns are deliberately narrow so a
genuinely broken adapter cannot loop forever.

## Runbook

> When a card dies with `Connection closed mid-response` (or another
> transport-interruption message) and shows **no** transient retry in the issue
> thread, the run was classified before this fix landed, or the seat is on the
> CLI engine. Check the run's `errorCode`: `null`/`acpx_turn_failed` means it
> was not recognised as transient. Re-dispatch the card; the retry will pick a
> fresh session. Do not park it as `blocked` — there is no deterministic fault
> to wait for.

* Server-side transient codes: `server/src/services/recovery/service.ts`
  (`TRANSIENT_INFRA_CONTINUATION_ERROR_CODES`) and
  `server/src/services/run-liveness.ts` (`TRANSIENT_UPSTREAM_ERROR_CODES`).
* Adapter docs: [`claude_local`](/adapters/claude-local) ·
  [`codex_local`](/adapters/codex-local) · [`gemini_local`](/adapters/gemini-local)
