import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syntheticCacheCrossover } from "../runner/cache-crossover.js";
import { syntheticTokenPricing } from "../runner/cost.js";
import { currentImplementationBinding } from "../runner/live-acceptance-pins.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const routes = { "task-simple-query": "simple_query", "task-bounded-read": "bounded_read", "task-implementation": "implementation", "task-debugging": "debugging", "task-high-risk-failure": "high_risk_failure", "task-other": "other" } as const;
const effort = { simple_query: "low", bounded_read: "medium", implementation: "high", debugging: "high", high_risk_failure: "xhigh", other: "high" } as const;

afterEach(() => { vi.useRealTimers(); vi.doUnmock("node:crypto"); vi.resetModules(); });

describe("one-time production challenge consumption", () => {
  it("consumes only after all acceptance checks, then rejects a second successful-use attempt", async () => {
    // Test-only crypto substitution: production has no verifier, reset, key, or clock injection seam.
    vi.resetModules(); vi.doMock("node:crypto", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:crypto")>()), verify: () => true }));
    const live = await import("../runner/live-acceptance.js"); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-07-26T00:30:00Z"));
    const artifact = { schemaVersion: 2 as const, capturedAt: "2026-07-26T00:00:00Z", providerFingerprint: hash("provider"), modelFingerprint: hash("model"), priceTableFingerprint: live.canonicalPriceTableSha256(syntheticTokenPricing), cacheObservability: { protocolVersion: 1 as const, rawCachedTokensPresence: "observed" as const, verdict: "PASS" as const }, runs: Object.entries(routes).flatMap(([taskId, routeCase]) => (["fixed-xhigh", "fixed-high", "policy-shadow", "policy-enforce"] as const).map((mode) => ({ taskId, routeCase, highConfidence: routeCase === "simple_query" || routeCase === "bounded_read", highRisk: routeCase === "high_risk_failure", mode, repetition: 1 as const, selectedEffort: mode === "fixed-xhigh" ? "xhigh" : mode === "fixed-high" ? "high" : effort[routeCase as keyof typeof effort], ...(mode === "policy-shadow" ? { baselinePayloadHash: hash(`baseline:${taskId}`), appliedPayloadHash: hash(`baseline:${taskId}`) } : { appliedEffort: mode === "fixed-xhigh" ? "xhigh" : mode === "fixed-high" ? "high" : effort[routeCase as keyof typeof effort] }), providerRequests: 1, toolRounds: 1, retries: 0, usage: { inputTokens: 10, uncachedInputTokens: 5, outputTokens: 1, reasoningTokens: 1, cacheReadTokens: 5, cacheWriteTokens: 1 }, latencyMs: 1, effectiveCostMicros: 122, accepted: true, criticalFailure: false }))), cacheCrossover: structuredClone(syntheticCacheCrossover), reviews: [] };
    const proof = { artifactSha256: live.canonicalArtifactSha256(artifact), providerFingerprint: artifact.providerFingerprint, modelFingerprint: artifact.modelFingerprint, priceTableFingerprint: artifact.priceTableFingerprint, pricing: syntheticTokenPricing, ceilings: { maxProviderRequests: 33 as const, maxInputTokens: 1321, maxOutputTokens: 178, maxReasoningTokens: 300, maxEffectiveCostMicros: 100000 }, witnessedAt: "2026-07-26T00:00:00Z", witnessHash: live.pinnedWitnessHash, reviewerNonce: live.pinnedReviewerNonce, planSha256: live.frozenPlanSha256, ...currentImplementationBinding, issuedAt: "2026-07-26T00:00:00Z", expiresAt: "2026-07-26T01:00:00Z", signature: "AA==" };
    const receipt = live.validateTrustedLiveAcceptance(artifact, proof);
    expect(Object.isFrozen(receipt)).toBe(true); expect(receipt.artifactSha256).toBe(proof.artifactSha256);
    expect(() => live.validateTrustedLiveAcceptance(artifact, proof)).toThrow("challenge replayed");
  });
});
