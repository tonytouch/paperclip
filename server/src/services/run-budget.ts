import fs from "node:fs/promises";

import { logger } from "../middleware/logger.js";

/**
 * TON-1321: company-wide concurrency budget for the agent fleet.
 *
 * The per-seat counter (`policy.maxConcurrentRuns`) bounds *runs*, and the
 * per-seat default is 20. On a host with a cgroup memory budget that is
 * already saturated by the ACPX session processes those runs leave behind,
 * a per-seat counter is not a memory bound at all: 6 seats x 20 runs is 120
 * concurrent runs against a cgroup that is over its `memory.high` before the
 * first one starts.
 *
 * This module derives a company-wide cap from the cgroup/host memory budget
 * and exposes a memory-pressure predicate so dispatch can queue work instead
 * of thrashing the node event loop.
 */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Default memory reserved for everything that is not an agent run. */
export const DEFAULT_GLOBAL_RUN_RESERVE_BYTES = 2 * GIB;
/** Default memory attributed to one concurrent run (session + agent process). */
export const DEFAULT_GLOBAL_RUN_BYTES_PER_RUN = 512 * MIB;
/** Fraction of the memory limit at which dispatch is considered "pressured". */
export const DEFAULT_MEMORY_PRESSURE_RATIO = 0.9;
/** Cap used when the host exposes no usable memory budget at all. */
export const FALLBACK_GLOBAL_MAX_CONCURRENT_RUNS = 4;
/** Hard ceiling for the derived cap, however generous the host looks. */
export const GLOBAL_MAX_CONCURRENT_RUNS_CEILING = 32;

export const ENV_GLOBAL_MAX_CONCURRENT_RUNS = "PAPERCLIP_GLOBAL_MAX_CONCURRENT_RUNS";
export const ENV_MEMORY_BYTES_PER_RUN = "PAPERCLIP_MEMORY_BYTES_PER_RUN";
export const ENV_MEMORY_RESERVE_BYTES = "PAPERCLIP_MEMORY_RESERVE_BYTES";
export const ENV_MEMORY_PRESSURE_RATIO = "PAPERCLIP_MEMORY_PRESSURE_RATIO";

const CGROUP_V2_FILES = {
  current: "/sys/fs/cgroup/memory.current",
  high: "/sys/fs/cgroup/memory.high",
  max: "/sys/fs/cgroup/memory.max",
} as const;

const CGROUP_V1_FILES = {
  current: "/sys/fs/cgroup/memory/memory.usage_in_bytes",
  high: "/sys/fs/cgroup/memory/memory.soft_limit_in_bytes",
  max: "/sys/fs/cgroup/memory/memory.limit_in_bytes",
} as const;

/** cgroup v1 reports "unlimited" as a huge sentinel rather than a keyword. */
const CGROUP_UNLIMITED_BYTES = 9223372036854771712;

export interface CgroupMemorySnapshot {
  /** Bytes currently charged to the cgroup (null when unavailable). */
  currentBytes: number | null;
  /** `memory.high` — the reclaim threshold (null when unset). */
  highBytes: number | null;
  /** `memory.max` — the hard limit (null when unlimited). */
  maxBytes: number | null;
}

export type GlobalRunBudgetSource = "env" | "memory" | "fallback";

export interface GlobalRunBudget {
  /** Company-wide concurrent run cap. */
  maxConcurrentRuns: number;
  /** Memory attributed to one concurrent run. */
  bytesPerRun: number;
  /** Memory held back for non-run consumers (database, server, tooling). */
  reserveBytes: number;
  /** Ratio of the memory limit above which dispatch is paused. */
  pressureRatio: number;
  /** Where `maxConcurrentRuns` came from. */
  source: GlobalRunBudgetSource;
  /** Effective memory limit (high ?? max), null when unknown. */
  memoryLimitBytes: number | null;
  /** Memory currently charged to the cgroup, null when unknown. */
  memoryCurrentBytes: number | null;
  /** True when the cgroup is close enough to its limit to pause dispatch. */
  underMemoryPressure: boolean;
}

export type ReadTextFile = (path: string) => Promise<string | null>;

/** Parse a cgroup byte counter. Returns null for "max"/empty/garbage. */
export function parseMemoryBytes(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "max") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  if (value >= CGROUP_UNLIMITED_BYTES) return null;
  return Math.floor(value);
}

export function parseCgroupMemorySnapshot(raw: {
  current?: string | null;
  high?: string | null;
  max?: string | null;
}): CgroupMemorySnapshot {
  return {
    currentBytes: parseMemoryBytes(raw.current),
    highBytes: parseMemoryBytes(raw.high),
    maxBytes: parseMemoryBytes(raw.max),
  };
}

/** The effective memory budget for the process: `memory.high` wins over `memory.max`. */
export function effectiveMemoryLimitBytes(snapshot: CgroupMemorySnapshot): number | null {
  return snapshot.highBytes ?? snapshot.maxBytes ?? null;
}

export function isUnderMemoryPressure(
  snapshot: CgroupMemorySnapshot,
  pressureRatio: number = DEFAULT_MEMORY_PRESSURE_RATIO,
): boolean {
  const limitBytes = effectiveMemoryLimitBytes(snapshot);
  if (limitBytes == null || snapshot.currentBytes == null) return false;
  if (limitBytes <= 0) return false;
  return snapshot.currentBytes >= limitBytes * pressureRatio;
}

/**
 * Derive the company-wide cap from the memory budget.
 *
 * `usable = limit - reserve`, and each concurrent run is charged
 * `bytesPerRun`. The result is clamped to at least 1 (a host that cannot hold
 * a single run still runs one) and to {@link GLOBAL_MAX_CONCURRENT_RUNS_CEILING}.
 */
export function resolveGlobalRunCap(options: {
  snapshot: CgroupMemorySnapshot;
  bytesPerRun?: number;
  reserveBytes?: number;
  explicit?: number | null;
}): { maxConcurrentRuns: number; source: GlobalRunBudgetSource } {
  const bytesPerRun = Math.max(1, options.bytesPerRun ?? DEFAULT_GLOBAL_RUN_BYTES_PER_RUN);
  const reserveBytes = Math.max(0, options.reserveBytes ?? DEFAULT_GLOBAL_RUN_RESERVE_BYTES);

  if (options.explicit != null && Number.isFinite(options.explicit)) {
    return {
      maxConcurrentRuns: clampRunCap(Math.floor(options.explicit)),
      source: "env",
    };
  }

  const limitBytes = effectiveMemoryLimitBytes(options.snapshot);
  if (limitBytes == null) {
    return { maxConcurrentRuns: FALLBACK_GLOBAL_MAX_CONCURRENT_RUNS, source: "fallback" };
  }

  const usableBytes = limitBytes - reserveBytes;
  if (usableBytes <= 0) {
    return { maxConcurrentRuns: 1, source: "memory" };
  }
  return {
    maxConcurrentRuns: clampRunCap(Math.floor(usableBytes / bytesPerRun)),
    source: "memory",
  };
}

function clampRunCap(value: number): number {
  if (!Number.isFinite(value)) return FALLBACK_GLOBAL_MAX_CONCURRENT_RUNS;
  return Math.min(GLOBAL_MAX_CONCURRENT_RUNS_CEILING, Math.max(1, value));
}

function parseEnvNumber(
  env: Record<string, string | undefined>,
  key: string,
): number | null {
  const raw = env[key];
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Resolve the full company-wide budget from the environment and a cgroup
 * snapshot. Every knob is configurable; nothing here is a hardcoded literal.
 */
export function resolveGlobalRunBudget(options: {
  env?: Record<string, string | undefined>;
  snapshot: CgroupMemorySnapshot;
}): GlobalRunBudget {
  const env = options.env ?? process.env;
  const bytesPerRun =
    parseEnvNumber(env, ENV_MEMORY_BYTES_PER_RUN) ?? DEFAULT_GLOBAL_RUN_BYTES_PER_RUN;
  const reserveBytes =
    parseEnvNumber(env, ENV_MEMORY_RESERVE_BYTES) ?? DEFAULT_GLOBAL_RUN_RESERVE_BYTES;
  const pressureRatioRaw = parseEnvNumber(env, ENV_MEMORY_PRESSURE_RATIO);
  const pressureRatio =
    pressureRatioRaw != null && pressureRatioRaw > 0 && pressureRatioRaw <= 1
      ? pressureRatioRaw
      : DEFAULT_MEMORY_PRESSURE_RATIO;
  const explicit = parseEnvNumber(env, ENV_GLOBAL_MAX_CONCURRENT_RUNS);

  const { maxConcurrentRuns, source } = resolveGlobalRunCap({
    snapshot: options.snapshot,
    bytesPerRun,
    reserveBytes,
    explicit: explicit != null && explicit > 0 ? explicit : null,
  });

  return {
    maxConcurrentRuns,
    bytesPerRun,
    reserveBytes,
    pressureRatio,
    source,
    memoryLimitBytes: effectiveMemoryLimitBytes(options.snapshot),
    memoryCurrentBytes: options.snapshot.currentBytes,
    underMemoryPressure: isUnderMemoryPressure(options.snapshot, pressureRatio),
  };
}

async function readTextFileSafe(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Read the cgroup memory counters for the current process.
 *
 * Supports cgroup v2 (`memory.current`/`memory.high`/`memory.max`) and falls
 * back to v1 (`memory/memory.usage_in_bytes` and friends).
 */
export async function readCgroupMemorySnapshot(
  readFile: ReadTextFile = readTextFileSafe,
): Promise<CgroupMemorySnapshot> {
  const v2 = await readCgroupMemorySnapshotFrom(CGROUP_V2_FILES, readFile);
  if (v2.currentBytes != null || v2.highBytes != null || v2.maxBytes != null) return v2;
  const v1 = await readCgroupMemorySnapshotFrom(CGROUP_V1_FILES, readFile);
  return v1;
}

async function readCgroupMemorySnapshotFrom(
  files: { current: string; high: string; max: string },
  readFile: ReadTextFile,
): Promise<CgroupMemorySnapshot> {
  const [current, high, max] = await Promise.all([
    readFile(files.current),
    readFile(files.high),
    readFile(files.max),
  ]);
  return parseCgroupMemorySnapshot({ current, high, max });
}

const EMPTY_SNAPSHOT: CgroupMemorySnapshot = {
  currentBytes: null,
  highBytes: null,
  maxBytes: null,
};

let cachedSnapshot: { snapshot: CgroupMemorySnapshot; readAtMs: number } | null = null;
const SNAPSHOT_TTL_MS = 5_000;

/**
 * Cached cgroup snapshot. The counters move on every page fault, but the
 * dispatch decision does not need millisecond resolution; re-reading three
 * small files on every claim would add avoidable IO pressure on a host that
 * is already in reclaim.
 */
export async function getCgroupMemorySnapshot(
  options: { ttlMs?: number; readFile?: ReadTextFile; now?: () => number } = {},
): Promise<CgroupMemorySnapshot> {
  const ttlMs = options.ttlMs ?? SNAPSHOT_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const nowMs = now();
  if (cachedSnapshot && nowMs - cachedSnapshot.readAtMs < ttlMs) {
    return cachedSnapshot.snapshot;
  }
  const snapshot = await readCgroupMemorySnapshot(options.readFile);
  cachedSnapshot = { snapshot, readAtMs: nowMs };
  return snapshot;
}

export function resetCgroupMemorySnapshotCache(): void {
  cachedSnapshot = null;
}

/** Resolve the company-wide budget from the live cgroup snapshot. */
export async function getGlobalRunBudget(
  options: {
    env?: Record<string, string | undefined>;
    readFile?: ReadTextFile;
    now?: () => number;
    ttlMs?: number;
  } = {},
): Promise<GlobalRunBudget> {
  const snapshot = await getCgroupMemorySnapshot({
    ttlMs: options.ttlMs,
    readFile: options.readFile,
    now: options.now,
  });
  return resolveGlobalRunBudget({ env: options.env ?? process.env, snapshot });
}

/**
 * A per-company lock so the cap check and the claim that follows it cannot
 * interleave across seats. The fleet is a single server process, so an
 * in-process lock is enough to keep the company-wide cap honest.
 */
const companyLocks = new Map<string, { promise: Promise<void>; startedAtMs: number }>();
const COMPANY_LOCK_STALE_MS = 30_000;

export async function withCompanyRunBudgetLock<T>(
  companyId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = companyLocks.get(companyId);
  if (previous) {
    const elapsedMs = Date.now() - previous.startedAtMs;
    const remainingMs = COMPANY_LOCK_STALE_MS - elapsedMs;
    if (remainingMs > 0) {
      await Promise.race([
        previous.promise,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remainingMs);
          if (typeof timer.unref === "function") timer.unref();
        }),
      ]);
    }
  }
  const run = fn();
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  companyLocks.set(companyId, { promise: marker, startedAtMs: Date.now() });
  try {
    return await run;
  } finally {
    if (companyLocks.get(companyId)?.promise === marker) {
      companyLocks.delete(companyId);
    }
  }
}

export function logRunBudgetDecision(params: {
  companyId: string;
  agentId?: string;
  runId?: string;
  decision: "paused_memory_pressure" | "paused_global_cap" | "allowed";
  budget: GlobalRunBudget;
  companyRunningRuns?: number;
}): void {
  const payload = {
    companyId: params.companyId,
    agentId: params.agentId,
    runId: params.runId,
    decision: params.decision,
    maxConcurrentRuns: params.budget.maxConcurrentRuns,
    source: params.budget.source,
    memoryCurrentBytes: params.budget.memoryCurrentBytes,
    memoryLimitBytes: params.budget.memoryLimitBytes,
    companyRunningRuns: params.companyRunningRuns,
  };
  if (params.decision === "allowed") {
    logger.debug(payload, "global run budget allowed dispatch");
    return;
  }
  logger.warn(payload, "global run budget paused dispatch");
}
