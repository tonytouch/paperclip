import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres parked-retry cancel route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue cancel held by its own parked scheduled retry", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-parked-retry-cancel-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function agentActor(
    companyId: string,
    agentId: string,
    runId: string,
  ): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    };
  }

  /**
   * Seed a company + agent, an issue held by a parked `scheduled_retry` row
   * (the TON-1185 shape: the parked row IS the issue's executionRunId and the
   * issue's checkoutRunId is NULL), and return the ids.
   */
  async function seedIssueHeldByParkedRetry() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const foreignAgentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const parkedRunId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date("2026-05-06T18:00:00.000Z");
    const scheduledRetryAt = new Date("2026-05-06T19:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
      {
        id: foreignAgentId,
        companyId,
        name: "OtherAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "transient upstream error",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      updatedAt: now,
      createdAt: now,
    });
    // The actor's own live run - it must exist as a row because activity-log
    // writes carry a foreign key to heartbeat_runs. It deliberately carries
    // NO issueId: the issue is held by the parked retry, not by this run.
    const actorRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: actorRunId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      startedAt: now,
      contextSnapshot: { wakeReason: "manual" },
      updatedAt: now,
      createdAt: now,
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "bounded_transient_heartbeat_retry",
      payload: {
        issueId,
        retryOfRunId: sourceRunId,
        scheduledRetryAt: scheduledRetryAt.toISOString(),
      },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: parkedRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      wakeupRequestId,
      retryOfRunId: sourceRunId,
      scheduledRetryAt,
      scheduledRetryAttempt: 2,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: {
        issueId,
        wakeReason: "bounded_transient_heartbeat_retry",
        retryOfRunId: sourceRunId,
        scheduledRetryAt: scheduledRetryAt.toISOString(),
        scheduledRetryAttempt: 2,
        retryReason: "transient_failure",
      },
      updatedAt: now,
      createdAt: now,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: parkedRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue held by its own parked retry",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: parkedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return {
      companyId,
      agentId,
      foreignAgentId,
      issueId,
      sourceRunId,
      parkedRunId,
      actorRunId,
    };
  }

  it("lets the assignee's own agent token cancel an issue held by its own parked retry", async () => {
    const { companyId, agentId, issueId, parkedRunId, actorRunId, sourceRunId } = await seedIssueHeldByParkedRetry();

    const before = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, attempt: heartbeatRuns.scheduledRetryAttempt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, parkedRunId));
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ status: "scheduled_retry", attempt: 2 });

    const res = await request(createApp(agentActor(companyId, agentId, actorRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body?.status).toBe("cancelled");

    // The parked row goes terminal.
    const after = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        attempt: heartbeatRuns.scheduledRetryAttempt,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, parkedRunId));
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("cancelled");
    expect(after[0].attempt).toBe(2);
    expect(after[0].finishedAt).toBeTruthy();

    // The issue's execution lock is released.
    const issueRow = await db
      .select({
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(issueRow[0]).toEqual({
      status: "cancelled",
      checkoutRunId: null,
      executionRunId: null,
    });

    // No NEW run was spawned for the issue by the cancel: the only rows that
    // ever referenced the issue are the failed source run and the (now
    // cancelled) parked retry.
    const issueRuns = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    const referencing = issueRuns.filter((row) => {
      const snapshot = row.contextSnapshot as Record<string, unknown> | null;
      return snapshot && snapshot.issueId === issueId;
    });
    expect(referencing.map((row) => row.id).sort()).toEqual([sourceRunId, parkedRunId].sort());
    expect(referencing.find((row) => row.id === parkedRunId)?.status).toBe("cancelled");
  });

  it("still refuses a genuine foreign lock: another agent's live running row", async () => {
    const { companyId, agentId, foreignAgentId, issueId, actorRunId } = await seedIssueHeldByParkedRetry();
    const foreignRunId = randomUUID();

    // Replace the parked lock with a LIVE running row owned by another agent.
    await db.insert(heartbeatRuns).values({
      id: foreignRunId,
      companyId,
      agentId: foreignAgentId,
      invocationSource: "manual",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId },
    });
    await db
      .update(issues)
      .set({ executionRunId: foreignRunId, checkoutRunId: foreignRunId })
      .where(eq(issues.id, issueId));

    const res = await request(createApp(agentActor(companyId, agentId, actorRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body?.error).toBe("Issue run ownership conflict");

    const issueRow = await db
      .select({ status: issues.status, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(issueRow[0].status).toBe("in_progress");
    expect(issueRow[0].executionRunId).toBe(foreignRunId);
  });
});
