import { describe, expect, it } from "vitest";

import {
  DEFAULT_GLOBAL_RUN_BYTES_PER_RUN,
  DEFAULT_GLOBAL_RUN_RESERVE_BYTES,
  ENV_GLOBAL_MAX_CONCURRENT_RUNS,
  ENV_MEMORY_BYTES_PER_RUN,
  ENV_MEMORY_RESERVE_BYTES,
  ENV_MEMORY_PRESSURE_RATIO,
  FALLBACK_GLOBAL_MAX_CONCURRENT_RUNS,
  GLOBAL_MAX_CONCURRENT_RUNS_CEILING,
  effectiveMemoryLimitBytes,
  getGlobalRunBudget,
  isUnderMemoryPressure,
  parseCgroupMemorySnapshot,
  parseMemoryBytes,
  readCgroupMemorySnapshot,
  resolveGlobalRunBudget,
  resolveGlobalRunCap,
  withCompanyRunBudgetLock,
} from "../services/run-budget.js";

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

describe("parseMemoryBytes", () => {
  it("parses byte counters", () => {
    expect(parseMemoryBytes("1048576")).toBe(1048576);
    expect(parseMemoryBytes("  42\n")).toBe(42);
  });

  it("treats max, empty and garbage as unknown", () => {
    expect(parseMemoryBytes("max")).toBeNull();
    expect(parseMemoryBytes("")).toBeNull();
    expect(parseMemoryBytes(null)).toBeNull();
    expect(parseMemoryBytes("not-a-number")).toBeNull();
  });

  it("treats the cgroup v1 unlimited sentinel as unknown", () => {
    expect(parseMemoryBytes("9223372036854771712")).toBeNull();
  });
});

describe("resolveGlobalRunCap", () => {
  it("derives the cap from the cgroup memory budget", () => {
    const snapshot = parseCgroupMemorySnapshot({
      current: String(10 * GIB),
      high: String(10 * GIB),
      max: "max",
    });
    const result = resolveGlobalRunCap({
      snapshot,
      bytesPerRun: 512 * MIB,
      reserveBytes: 2 * GIB,
    });
    // (10GiB - 2GiB) / 512MiB === 16
    expect(result.maxConcurrentRuns).toBe(16);
    expect(result.source).toBe("memory");
  });

  it("honours an explicit override", () => {
    const snapshot = parseCgroupMemorySnapshot({ current: "1", high: String(10 * GIB), max: "max" });
    const result = resolveGlobalRunCap({ snapshot, explicit: 3 });
    expect(result.maxConcurrentRuns).toBe(3);
    expect(result.source).toBe("env");
  });

  it("falls back when the host exposes no memory limit", () => {
    const snapshot = parseCgroupMemorySnapshot({ current: "1", high: "max", max: "max" });
    const result = resolveGlobalRunCap({ snapshot });
    expect(result.maxConcurrentRuns).toBe(FALLBACK_GLOBAL_MAX_CONCURRENT_RUNS);
    expect(result.source).toBe("fallback");
  });

  it("never returns zero even when the budget is exhausted", () => {
    const snapshot = parseCgroupMemorySnapshot({ current: "1", high: String(GIB), max: "max" });
    const result = resolveGlobalRunCap({
      snapshot,
      bytesPerRun: 512 * MIB,
      reserveBytes: 4 * GIB,
    });
    expect(result.maxConcurrentRuns).toBe(1);
  });

  it("clamps to the ceiling", () => {
    const snapshot = parseCgroupMemorySnapshot({ current: "1", high: String(512 * GIB), max: "max" });
    const result = resolveGlobalRunCap({ snapshot, bytesPerRun: MIB, reserveBytes: 0 });
    expect(result.maxConcurrentRuns).toBe(GLOBAL_MAX_CONCURRENT_RUNS_CEILING);
  });
});

describe("memory pressure", () => {
  it("uses memory.high as the effective limit", () => {
    const snapshot = parseCgroupMemorySnapshot({ current: "1", high: String(GIB), max: String(4 * GIB) });
    expect(effectiveMemoryLimitBytes(snapshot)).toBe(GIB);
  });

  it("triggers below the limit and stays quiet above it", () => {
    const snapshot = parseCgroupMemorySnapshot({
      current: String(Math.floor(GIB * 0.95)),
      high: String(GIB),
      max: "max",
    });
    expect(isUnderMemoryPressure(snapshot, 0.9)).toBe(true);
    const idle = parseCgroupMemorySnapshot({ current: String(Math.floor(GIB * 0.5)), high: String(GIB) });
    expect(isUnderMemoryPressure(idle, 0.9)).toBe(false);
  });

  it("is not pressured when the limit is unknown", () => {
    const snapshot = parseCgroupMemorySnapshot({ current: String(GIB), high: "max", max: "max" });
    expect(isUnderMemoryPressure(snapshot, 0.9)).toBe(false);
  });
});

describe("resolveGlobalRunBudget", () => {
  it("is configurable through the environment", () => {
    const snapshot = parseCgroupMemorySnapshot({
      current: String(9 * GIB),
      high: String(10 * GIB),
      max: "max",
    });
    const budget = resolveGlobalRunBudget({
      env: {
        [ENV_MEMORY_BYTES_PER_RUN]: String(1024 * MIB),
        [ENV_MEMORY_RESERVE_BYTES]: String(2 * GIB),
        [ENV_MEMORY_PRESSURE_RATIO]: "0.5",
      },
      snapshot,
    });
    expect(budget.bytesPerRun).toBe(1024 * MIB);
    expect(budget.reserveBytes).toBe(2 * GIB);
    expect(budget.maxConcurrentRuns).toBe(8);
    expect(budget.underMemoryPressure).toBe(true);
  });

  it("uses the explicit cap override ahead of the memory derivation", () => {
    const snapshot = parseCgroupMemorySnapshot({ current: "1", high: String(10 * GIB), max: "max" });
    const budget = resolveGlobalRunBudget({
      env: { [ENV_GLOBAL_MAX_CONCURRENT_RUNS]: "5" },
      snapshot,
    });
    expect(budget.maxConcurrentRuns).toBe(5);
    expect(budget.source).toBe("env");
  });

  it("falls back to the documented defaults", () => {
    const budget = resolveGlobalRunBudget({ env: {}, snapshot: parseCgroupMemorySnapshot({}) });
    expect(budget.bytesPerRun).toBe(DEFAULT_GLOBAL_RUN_BYTES_PER_RUN);
    expect(budget.reserveBytes).toBe(DEFAULT_GLOBAL_RUN_RESERVE_BYTES);
    expect(budget.maxConcurrentRuns).toBe(FALLBACK_GLOBAL_MAX_CONCURRENT_RUNS);
  });
});

describe("readCgroupMemorySnapshot", () => {
  it("reads the v2 counters", async () => {
    const files: Record<string, string> = {
      "/sys/fs/cgroup/memory.current": String(1234),
      "/sys/fs/cgroup/memory.high": String(5678),
      "/sys/fs/cgroup/memory.max": "max",
    };
    const snapshot = await readCgroupMemorySnapshot(async (path) => files[path] ?? null);
    expect(snapshot).toEqual({ currentBytes: 1234, highBytes: 5678, maxBytes: null });
  });

  it("falls back to the v1 counters", async () => {
    const files: Record<string, string> = {
      "/sys/fs/cgroup/memory/memory.usage_in_bytes": String(99),
      "/sys/fs/cgroup/memory/memory.soft_limit_in_bytes": String(100),
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": "max",
    };
    const snapshot = await readCgroupMemorySnapshot(async (path) => files[path] ?? null);
    expect(snapshot).toEqual({ currentBytes: 99, highBytes: 100, maxBytes: null });
  });

  it("returns an unknown snapshot when nothing is readable", async () => {
    const snapshot = await readCgroupMemorySnapshot(async () => null);
    expect(snapshot).toEqual({ currentBytes: null, highBytes: null, maxBytes: null });
  });
});

describe("getGlobalRunBudget", () => {
  it("derives the budget from a readable cgroup", async () => {
    const budget = await getGlobalRunBudget({
      env: {},
      ttlMs: 0,
      readFile: async (path) =>
        path === "/sys/fs/cgroup/memory.high" ? String(10 * GIB) : path === "/sys/fs/cgroup/memory.current" ? String(GIB) : null,
    });
    expect(budget.maxConcurrentRuns).toBeGreaterThan(0);
    expect(budget.memoryLimitBytes).toBe(10 * GIB);
  });
});

describe("withCompanyRunBudgetLock", () => {
  it("serializes concurrent dispatch decisions for one company", async () => {
    const events: string[] = [];
    const first = withCompanyRunBudgetLock("company-1", async () => {
      events.push("a-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push("a-end");
    });
    const second = withCompanyRunBudgetLock("company-1", async () => {
      events.push("b-start");
      events.push("b-end");
    });
    await Promise.all([first, second]);
    expect(events).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("does not serialise across companies", async () => {
    const events: string[] = [];
    await Promise.all([
      withCompanyRunBudgetLock("company-1", async () => {
        events.push("a-start");
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push("a-end");
      }),
      withCompanyRunBudgetLock("company-2", async () => {
        events.push("b-start");
        events.push("b-end");
      }),
    ]);
    expect(events.indexOf("b-start")).toBeLessThan(events.indexOf("a-end"));
  });
});
