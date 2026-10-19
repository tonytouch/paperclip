import { describe, expect, it } from "vitest";
import { isProviderQuotaRateLimitMessage } from "../services/heartbeat.js";

// TON-458: local adapters surface an upstream 429 as a plain `adapter_failed`
// run whose only evidence is the human-readable error text. These cases must be
// classified as provider quota so the enqueue backoff gate engages and stops the
// self-amplifying failure storm.
describe("isProviderQuotaRateLimitMessage", () => {
  it("classifies the OpenCode Zen free-tier rate-limit message as provider quota", () => {
    expect(
      isProviderQuotaRateLimitMessage("Rate limit exceeded. Please try again later."),
    ).toBe(true);
  });

  it("classifies explicit 429 responses as provider quota", () => {
    expect(isProviderQuotaRateLimitMessage("HTTP 429 Too Many Requests")).toBe(true);
    expect(isProviderQuotaRateLimitMessage("Request failed with status code 429")).toBe(true);
  });

  it("classifies quota and usage-limit refusals as provider quota", () => {
    expect(isProviderQuotaRateLimitMessage("You have exceeded your daily usage quota")).toBe(true);
    expect(isProviderQuotaRateLimitMessage("FreeUsageLimitError: free usage limit reached")).toBe(true);
    expect(isProviderQuotaRateLimitMessage("quota exceeded for this billing period")).toBe(true);
  });

  it("does not classify unrelated adapter failures as provider quota", () => {
    expect(isProviderQuotaRateLimitMessage("Step interrupted")).toBe(false);
    expect(isProviderQuotaRateLimitMessage("spawn claude ENOENT")).toBe(false);
    expect(isProviderQuotaRateLimitMessage("Adapter failed")).toBe(false);
    expect(isProviderQuotaRateLimitMessage("network connection reset")).toBe(false);
  });

  it("handles non-string and empty input", () => {
    expect(isProviderQuotaRateLimitMessage(null)).toBe(false);
    expect(isProviderQuotaRateLimitMessage(undefined)).toBe(false);
    expect(isProviderQuotaRateLimitMessage(429)).toBe(false);
    expect(isProviderQuotaRateLimitMessage("")).toBe(false);
    expect(isProviderQuotaRateLimitMessage("   ")).toBe(false);
  });
});
