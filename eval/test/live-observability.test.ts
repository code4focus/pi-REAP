import { describe, expect, it } from "vitest";
import { classifyLiveCacheComparison, recordObservedRawCacheRead, recordPiAssistantUsage, recordPiNormalizedCacheRead } from "../runner/live-observability.js";
import { loadInstalledPiResponsesShared } from "../runner/live-production.js";

describe("typed live cache observability protocol", () => {
  it("uses Pi 0.82.1's exported Responses stream parser to normalize a raw positive cached_tokens fixture before recording it", async () => {
    const shared = await loadInstalledPiResponsesShared();
    const output = { content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    async function* fixture(): AsyncGenerator<unknown> { yield { type: "response.completed", response: { status: "completed", usage: { input_tokens: 200, input_tokens_details: { cached_tokens: 128, cache_write_tokens: 0 }, output_tokens: 2, total_tokens: 202 } } }; }
    await shared.processResponsesStream(fixture(), output, { push() {} }, { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, {});
    expect(output.usage.cacheRead).toBe(128);
    expect(recordPiAssistantUsage(output.usage)).toStrictEqual({ rawCachedTokens: { status: "unavailable_at_pi_normalized_boundary" }, piNormalizedCacheReadTokens: 128, liveEvalCacheReadTokens: 128 });
    expect(() => recordObservedRawCacheRead(128, { cacheRead: 0 })).toThrow("does not match");
  });

  it("distinguishes PASS, REGRESSION, ENVIRONMENT_UNQUALIFIED, and ambiguous normalized zero", () => {
    const raw = (value: number) => recordObservedRawCacheRead(value, { cacheRead: value });
    expect(classifyLiveCacheComparison([{ positiveControl: raw(10), crossover: raw(8) }])).toBe("PASS");
    expect(classifyLiveCacheComparison([{ positiveControl: raw(10), crossover: raw(0) }])).toBe("REGRESSION");
    expect(classifyLiveCacheComparison([{ positiveControl: raw(0), crossover: raw(0) }])).toBe("ENVIRONMENT_UNQUALIFIED");
    expect(classifyLiveCacheComparison([{ positiveControl: recordPiNormalizedCacheRead(0), crossover: recordPiNormalizedCacheRead(0) }])).toBe("OBSERVABILITY_UNAVAILABLE");
  });
});
