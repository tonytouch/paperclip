import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// TON-1243: the startup heartbeat recovery suite scans the (large)
// heartbeat_runs table. It used to be awaited BEFORE server.listen(), so every
// boot left the API dark (measured: 98s with no listener; one boot died
// before it ever listened) and no seat could be woken, no run could report
// back, and no recovery action could be filed.
const serverIndexSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts"),
  "utf8",
);

describe("startup ordering", () => {
  it("binds the HTTP listener before awaiting the startup heartbeat recovery", () => {
    const listenIdx = serverIndexSrc.indexOf("server.listen(");
    const recoveryAwaitIdx = serverIndexSrc.indexOf("await startupHeartbeatRecoveryPromise");
    expect(listenIdx).toBeGreaterThan(-1);
    expect(recoveryAwaitIdx).toBeGreaterThan(-1);
    expect(recoveryAwaitIdx).toBeGreaterThan(listenIdx);
  });

  it("schedules the startup recovery instead of awaiting it in place", () => {
    expect(serverIndexSrc).toContain("startupHeartbeatRecoveryPromise = startupHeartbeatRecovery;");
    expect(serverIndexSrc).not.toMatch(/await startupHeartbeatRecovery;/);
  });

  it("still awaits the recovery once the listener is bound", () => {
    expect(serverIndexSrc).toMatch(
      /if \(startupHeartbeatRecoveryPromise\) \{\s*\n\s*await startupHeartbeatRecoveryPromise;\s*\n\s*\}/,
    );
  });
});
