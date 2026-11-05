import { describe, expect, it } from "vitest";
import { isTransportInterruptionMessage } from "./transient-transport.js";

describe("isTransportInterruptionMessage", () => {
  it("detects the mid-response connection drop", () => {
    expect(
      isTransportInterruptionMessage(
        "Internal error: API Error: Connection closed mid-response. The response above may be incomplete.",
      ),
    ).toBe(true);
    expect(isTransportInterruptionMessage("Connection closed mid-response")).toBe(true);
  });

  it("detects the other transport-level signals", () => {
    expect(isTransportInterruptionMessage("socket hang up")).toBe(true);
    expect(isTransportInterruptionMessage("read ECONNRESET")).toBe(true);
    expect(isTransportInterruptionMessage("write EPIPE")).toBe(true);
    expect(isTransportInterruptionMessage("Connection reset by peer")).toBe(true);
    expect(isTransportInterruptionMessage("Premature close")).toBe(true);
  });

  it("does not treat capacity refusals as transport interruptions", () => {
    expect(isTransportInterruptionMessage("429 rate limit exceeded")).toBe(false);
    expect(isTransportInterruptionMessage("overloaded_error")).toBe(false);
    expect(isTransportInterruptionMessage("503 service unavailable")).toBe(false);
  });

  it("does not treat deterministic faults as transport interruptions", () => {
    expect(isTransportInterruptionMessage("Invalid request_error: Unknown parameter 'foo'.")).toBe(
      false,
    );
    expect(isTransportInterruptionMessage("context window exceeds limit")).toBe(false);
  });

  it("ignores non-string and empty input", () => {
    expect(isTransportInterruptionMessage(undefined)).toBe(false);
    expect(isTransportInterruptionMessage(null)).toBe(false);
    expect(isTransportInterruptionMessage("")).toBe(false);
    expect(isTransportInterruptionMessage("   ")).toBe(false);
  });
});
