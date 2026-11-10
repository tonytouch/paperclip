import { describe, expect, it, beforeEach } from "vitest";

import type { AcpRuntime, AcpRuntimeHandle } from "acpx/runtime";

import {
  releaseAcpxSession,
  resetLiveAcpxSessions,
  retainAcpxSession,
  trackAcpxSession,
} from "./execute.js";

type CloseCall = { handle: unknown; reason: string; discardPersistentState: boolean };

function createFakeRuntime(closed: CloseCall[]) {
  return {
    close: async (input: CloseCall) => {
      closed.push(input);
    },
  } as unknown as AcpRuntime;
}

function createHandle(id: string): AcpRuntimeHandle {
  return { sessionKey: id, backend: "claude", runtimeSessionName: id } as AcpRuntimeHandle;
}

describe("ACPX session fleet (TON-1321)", () => {
  beforeEach(() => {
    resetLiveAcpxSessions();
  });

  it("closes an idle session for the same seat when a newer session starts", async () => {
    const closed: CloseCall[] = [];
    const runtime = createFakeRuntime(closed);

    await trackAcpxSession({
      agentKey: "company-1:agent-1",
      sessionKey: "session-a",
      runtime,
      handle: createHandle("session-a"),
    });
    await trackAcpxSession({
      agentKey: "company-1:agent-1",
      sessionKey: "session-b",
      runtime,
      handle: createHandle("session-b"),
    });

    expect(closed).toHaveLength(1);
    expect(closed[0].handle).toMatchObject({ sessionKey: "session-a" });
    expect(closed[0].discardPersistentState).toBe(false);
  });

  it("does not close a session that still has a running turn", async () => {
    const closed: CloseCall[] = [];
    const runtime = createFakeRuntime(closed);

    await trackAcpxSession({
      agentKey: "company-1:agent-1",
      sessionKey: "session-a",
      runtime,
      handle: createHandle("session-a"),
    });
    retainAcpxSession("company-1:agent-1", "session-a");

    await trackAcpxSession({
      agentKey: "company-1:agent-1",
      sessionKey: "session-b",
      runtime,
      handle: createHandle("session-b"),
    });

    expect(closed).toHaveLength(0);

    // Once the older turn ends, both older sessions are idle and the seat
    // keeps only the newest one.
    releaseAcpxSession("company-1:agent-1", "session-a");
    await trackAcpxSession({
      agentKey: "company-1:agent-1",
      sessionKey: "session-c",
      runtime,
      handle: createHandle("session-c"),
    });

    expect(closed).toHaveLength(2);
    expect(closed.map((call) => (call.handle as AcpRuntimeHandle).sessionKey).sort()).toEqual([
      "session-a",
      "session-b",
    ]);
  });

  it("keeps seats independent", async () => {
    const closed: CloseCall[] = [];
    const runtime = createFakeRuntime(closed);

    await trackAcpxSession({
      agentKey: "company-1:agent-1",
      sessionKey: "session-a",
      runtime,
      handle: createHandle("session-a"),
    });
    await trackAcpxSession({
      agentKey: "company-1:agent-2",
      sessionKey: "session-b",
      runtime,
      handle: createHandle("session-b"),
    });

    expect(closed).toHaveLength(0);
  });

  it("swallows close failures so a superseded session cannot fail the new run", async () => {
    const runtime = {
      close: async () => {
        throw new Error("already gone");
      },
    } as unknown as AcpRuntime;

    await trackAcpxSession({
      agentKey: "company-1:agent-1",
      sessionKey: "session-a",
      runtime,
      handle: createHandle("session-a"),
    });
    await expect(
      trackAcpxSession({
        agentKey: "company-1:agent-1",
        sessionKey: "session-b",
        runtime,
        handle: createHandle("session-b"),
      }),
    ).resolves.toBeUndefined();
  });

  it("re-registering the same session keeps its running turn count", async () => {
    const closed: CloseCall[] = [];
    const runtime = createFakeRuntime(closed);

    await trackAcpxSession({
      agentKey: "company-1:agent-1",
      sessionKey: "session-a",
      runtime,
      handle: createHandle("session-a"),
    });
    retainAcpxSession("company-1:agent-1", "session-a");
    await trackAcpxSession({
      agentKey: "company-1:agent-1",
      sessionKey: "session-a",
      runtime,
      handle: createHandle("session-a"),
    });

    await trackAcpxSession({
      agentKey: "company-1:agent-1",
      sessionKey: "session-b",
      runtime,
      handle: createHandle("session-b"),
    });

    expect(closed).toHaveLength(0);
  });
});
