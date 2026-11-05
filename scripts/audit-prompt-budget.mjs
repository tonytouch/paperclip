#!/usr/bin/env node
/**
 * audit-prompt-budget.mjs — measure the prompt a card actually puts on the wire.
 *
 * TON-827 asked us to measure `len(description) + sum(len(ancestor.description))`
 * and compact the cards that came out fat. Measured against the deployed build,
 * that formula is wrong twice over:
 *
 *   1. ANCESTOR DESCRIPTIONS NEVER REACH THE PROMPT. `buildPaperclipTaskMarkdown`
 *      (server/src/services/heartbeat.ts) renders each ancestor as a one-line
 *      label — `- Parent: TON-1234 <title> (status) [priority]` — and never
 *      includes the ancestor's description. The ancestor chain therefore costs
 *      ~100 chars per level, not thousands. The `getAncestors` query *selects*
 *      `description`, but the prompt builder's `ancestors` input type does not
 *      have that field, so it is dropped at the type boundary.
 *
 *   2. THE FAT IS THE CONTINUATION SUMMARY. Every card carries a generated
 *      summary document (up to ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS = 8_000)
 *      which is replayed into the prompt on the next attempt. For most fat
 *      cards the summary is larger than the description.
 *
 * So this script measures what is really sent: description + continuation
 * summary + the wake comment, plus the ancestor chain *as the platform renders
 * it*.
 *
 * It also audits the thing that actually killed the fleet: genuine 2013 deaths
 * (`context window exceeds limit (2013)`), split by whether the platform
 * classified the run as a retryable transient or the run died hard.
 *
 * GUARD: `--assert` fails (exit 1) when
 *   - a card's LEAF DESCRIPTION alone exceeds CONTEXT_RESEED_MAX_DESCRIPTION_CHARS,
 *     because the re-seed then truncates it mid-sentence and can amputate the
 *     operative half ("Definition of done", "Required behaviour", "Do");
 *   - a card's TOTAL prompt exceeds the summary cap;
 *   - a hard 2013 death appears inside the window.
 *
 * The script re-reads the platform source to confirm the ancestor-rendering
 * claim still holds. If the platform changes, the audit fails loudly rather
 * than silently measuring the wrong thing.
 *
 * Usage:
 *   PAPERCLIP_API_URL=http://127.0.0.1:3100 PAPERCLIP_API_KEY=... \
 *     node scripts/audit-prompt-budget.mjs [--window-hours 24] [--assert]
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");

/** Mirrors server/src/services/context-reseed.ts. Verified against source by assertPlatformShape(). */
export const CONTEXT_RESEED_MAX_DESCRIPTION_CHARS = 4_000;
/** Mirrors server/src/services/context-reseed.ts. */
export const CONTEXT_RESEED_MAX_CONTINUATION_SUMMARY_CHARS = 4_000;
/** Mirrors server/src/services/issue-continuation-summary.ts. */
export const ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS = 8_000;

/** The literal upstream refusal we are auditing. */
export const CONTEXT_WINDOW_OVERFLOW_MARKER = "context window exceeds limit (2013)";

/** Error codes that mean "the platform classified this as retryable", not "the seat died". */
const TRANSIENT_ERROR_CODES = new Set([
  "acpx_transient_upstream",
  "acpx_transient_upsert",
  "acpx_transient_transcript_overflow",
]);

const OPEN_STATUSES = new Set(["todo", "in_progress", "in_review", "blocked"]);

/**
 * Render the ancestor chain the way the platform renders it: a label line per
 * ancestor, no description. Mirrors buildPaperclipTaskMarkdown.
 */
export function renderAncestorLabels(ancestors) {
  return ancestors.map((ancestor, index) => {
    const label = ancestor.identifier || ancestor.id;
    const status = ancestor.status ? ` (${ancestor.status})` : "";
    const priority = ancestor.priority ? ` [${ancestor.priority}]` : "";
    const title = ancestor.title ? ` ${ancestor.title}` : "";
    const prefix = index === 0 ? "Parent" : `Ancestor ${index + 1}`;
    return `- ${prefix}: ${label}${title}${status}${priority}`;
  });
}

/**
 * The prompt composition of one card, in chars.
 *
 * `description` and `summary` are the two unbounded contributors; `wakeComment`
 * is whatever the last human/agent comment was. Ancestors contribute only their
 * rendered label lines.
 */
export function measurePrompt({ description, summary, wakeComment, ancestors }) {
  const leafDescription = description ?? "";
  const continuationSummary = summary ?? "";
  const wake = wakeComment ?? "";
  const ancestorLabels = renderAncestorLabels(ancestors ?? []);
  const ancestorChars = ancestorLabels.reduce((sum, line) => sum + line.length, 0);

  return {
    descriptionChars: leafDescription.length,
    summaryChars: continuationSummary.length,
    wakeCommentChars: wake.length,
    ancestorChars,
    ancestorCount: ancestorLabels.length,
    totalChars:
      leafDescription.length +
      continuationSummary.length +
      wake.length +
      ancestorChars,
    // The legacy formula TON-827 was written against, kept for comparison.
    legacyDescPlusAncestorDescriptions:
      leafDescription.length +
      (ancestors ?? []).reduce((sum, a) => sum + (a.description?.length ?? 0), 0),
  };
}

/**
 * Classify a run against the 2013 marker.
 *
 * `hard` means the run died of the overflow without a transient classification —
 * that is the fleet-killing shape. `classified` means the platform recognised
 * it and made it retryable.
 */
export function classify2013Run(run) {
  const fields = ["errorCode", "error", "stderrExcerpt", "stdoutExcerpt", "resultJson", "nextAction", "livenessReason"];
  const carriesMarker = fields.some((field) => {
    const value = run?.[field];
    if (!value) return false;
    return JSON.stringify(value).includes(CONTEXT_WINDOW_OVERFLOW_MARKER);
  });
  if (!carriesMarker) return { carriesMarker: false, kind: null };
  const code = run.errorCode ?? null;
  const kind = code && TRANSIENT_ERROR_CODES.has(code) ? "classified" : "hard";
  return { carriesMarker: true, kind, errorCode: code };
}

/**
 * The platform renders ancestors without their descriptions. Confirm that
 * against the real source so this audit cannot quietly measure the wrong thing.
 */
export function assertPlatformShape(projectRoot = PROJECT_ROOT) {
  const heartbeatPath = path.join(projectRoot, "server", "src", "services", "heartbeat.ts");
  const source = readFileSync(heartbeatPath, "utf8");

  const start = source.indexOf("if (ancestors.length > 0) {");
  if (start === -1) {
    throw new Error(
      `Could not find the ancestor-rendering block in ${heartbeatPath}. ` +
        "The platform prompt shape changed — re-derive the prompt audit before trusting these numbers.",
    );
  }
  const ancestorBlock = source.slice(start, start + 900);
  if (/ancestor[^\n]*\.description|ancestors\[[^\]]*\]\.description/.test(ancestorBlock)) {
    throw new Error(
      `The ancestor-rendering block in ${heartbeatPath} now renders ancestor descriptions. ` +
        "This script's prompt model is stale — re-derive it.",
    );
  }
  return true;
}

function parseArgs(argv) {
  const args = { windowHours: 24, assert: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--assert") args.assert = true;
    else if (arg === "--window-hours") args.windowHours = Number(argv[++i]);
    else if (arg.startsWith("--window-hours=")) args.windowHours = Number(arg.split("=")[1]);
  }
  return args;
}

function apiClient(baseUrl, apiKey) {
  async function get(pathname) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`GET ${pathname} -> ${response.status}`);
    return response.json();
  }
  return { get };
}

/** Build parent -> child edges and resolve each issue's ancestor chain. */
export function buildAncestorChains(issues) {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const chains = new Map();
  for (const issue of issues) {
    const chain = [];
    const seen = new Set([issue.id]);
    let current = byId.get(issue.parentId ?? "");
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.push(current);
      current = byId.get(current.parentId ?? "");
    }
    chains.set(issue.id, chain);
  }
  return chains;
}

export async function runAudit({
  baseUrl,
  apiKey,
  companyId,
  windowHours = 24,
  agentIds = null,
  projectRoot = PROJECT_ROOT,
  now = () => new Date(),
}) {
  assertPlatformShape(projectRoot);
  const client = apiClient(baseUrl, apiKey);

  const agentsPayload = await client.get(`/api/companies/${companyId}/agents`);
  const agents = Array.isArray(agentsPayload) ? agentsPayload : (agentsPayload.agents ?? []);
  const seats = agentIds
    ? agents.filter((agent) => agentIds.includes(agent.id))
    : agents.filter((agent) => agent.status !== "paused");

  const issuesPayload = await client.get(`/api/companies/${companyId}/issues?limit=500`);
  const allIssues = Array.isArray(issuesPayload) ? issuesPayload : (issuesPayload.issues ?? []);
  const chains = buildAncestorChains(allIssues);

  const seatIds = new Set(seats.map((seat) => seat.id));
  const queue = allIssues.filter(
    (issue) => seatIds.has(issue.assigneeAgentId) && OPEN_STATUSES.has(issue.status),
  );

  const cards = [];
  for (const issue of queue) {
    const full = await client.get(`/api/issues/${issue.id}`);
    const detail = full.issue ?? full;
    let summary = "";
    try {
      const doc = await client.get(`/api/issues/${issue.id}/documents/continuation-summary`);
      summary = doc?.body ?? doc?.document?.latestBody ?? "";
    } catch {
      summary = "";
    }
    const measured = measurePrompt({
      description: detail.description,
      summary,
      ancestors: chains.get(issue.id) ?? [],
    });
    cards.push({
      id: issue.id,
      identifier: detail.identifier ?? issue.identifier,
      title: issue.title,
      status: issue.status,
      seat: seats.find((s) => s.id === issue.assigneeAgentId)?.name ?? issue.assigneeAgentId,
      ...measured,
    });
  }

  const runsPayload = await client.get(`/api/companies/${companyId}/heartbeat-runs`);
  const runs = Array.isArray(runsPayload) ? runsPayload : (runsPayload.runs ?? []);
  const cutoff = new Date(now().getTime() - windowHours * 3600 * 1000);
  const windowRuns = runs.filter((run) => {
    if (!seatIds.has(run.agentId)) return false;
    const startedAt = run.startedAt ?? run.createdAt;
    if (!startedAt) return false;
    return new Date(startedAt) >= cutoff;
  });

  const overflowRuns = windowRuns
    .map((run) => ({ run, verdict: classify2013Run(run) }))
    .filter((entry) => entry.verdict.carriesMarker)
    .map((entry) => ({
      id: entry.run.id,
      startedAt: entry.run.startedAt ?? entry.run.createdAt,
      agentId: entry.run.agentId,
      errorCode: entry.run.errorCode ?? null,
      kind: entry.verdict.kind,
      issueId: entry.run.contextSnapshot?.issueId ?? null,
    }));

  const descriptionOverBudget = cards.filter(
    (card) => card.descriptionChars > CONTEXT_RESEED_MAX_DESCRIPTION_CHARS,
  );
  const totalOverBudget = cards.filter(
    (card) => card.totalChars > ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS,
  );
  const hardOverflows = overflowRuns.filter((run) => run.kind === "hard");

  return {
    windowHours,
    seats: seats.map((seat) => ({ id: seat.id, name: seat.name, status: seat.status })),
    cards,
    overflowRuns,
    descriptionOverBudget,
    totalOverBudget,
    hardOverflows,
  };
}

export function renderReport(audit) {
  const lines = [];
  lines.push(`# Prompt-budget audit — ${audit.cards.length} open cards`);
  lines.push(`window: ${audit.windowHours}h`);
  lines.push("");
  lines.push("| card | seat | status | desc | summary | ancestors | total |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const card of [...audit.cards].sort((a, b) => b.totalChars - a.totalChars)) {
    lines.push(
      `| ${card.identifier} | ${card.seat} | ${card.status} | ${card.descriptionChars} | ${card.summaryChars} | ${card.ancestorCount} (${card.ancestorChars}c) | ${card.totalChars} |`,
    );
  }
  lines.push("");
  lines.push(`## Description over ${CONTEXT_RESEED_MAX_DESCRIPTION_CHARS} chars (re-seed truncates mid-sentence)`);
  for (const card of audit.descriptionOverBudget) {
    lines.push(`- ${card.identifier} — ${card.descriptionChars} chars — ${card.title}`);
  }
  lines.push("");
  lines.push(`## Total prompt over ${ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS} chars`);
  for (const card of audit.totalOverBudget) {
    lines.push(`- ${card.identifier} — ${card.totalChars} chars — ${card.title}`);
  }
  lines.push("");
  lines.push(`## 2013 deaths in window: ${audit.overflowRuns.length} (hard: ${audit.hardOverflows.length})`);
  for (const run of audit.overflowRuns) {
    lines.push(`- ${run.startedAt} ${run.kind} ${run.errorCode ?? "-"} ${run.issueId ?? "-"}`);
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = (process.env.PAPERCLIP_API_URL ?? "").replace(/\/+$/, "").replace(/\/api$/, "");
  const apiKey = process.env.PAPERCLIP_API_KEY;
  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  if (!baseUrl || !apiKey || !companyId) {
    console.error(
      "PAPERCLIP_API_URL, PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID are required.",
    );
    process.exit(2);
  }

  const audit = await runAudit({ baseUrl, apiKey, companyId, windowHours: args.windowHours });
  console.log(renderReport(audit));

  if (args.assert) {
    const failures = [];
    for (const card of audit.descriptionOverBudget) {
      failures.push(`${card.identifier}: description ${card.descriptionChars} > ${CONTEXT_RESEED_MAX_DESCRIPTION_CHARS}`);
    }
    for (const card of audit.totalOverBudget) {
      failures.push(`${card.identifier}: total prompt ${card.totalChars} > ${ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS}`);
    }
    for (const run of audit.hardOverflows) {
      failures.push(`hard 2013 death ${run.id} at ${run.startedAt}`);
    }
    if (failures.length > 0) {
      console.error("\nAUDIT FAILED:");
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exit(1);
    }
    console.error("\nAUDIT PASSED");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
