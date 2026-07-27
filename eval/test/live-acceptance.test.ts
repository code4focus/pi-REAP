import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { cacheControlsFingerprint, syntheticCacheCrossover, validateCacheCrossover } from "../runner/cache-crossover.js";
import { acceptedBaseSha256, canonicalArtifactSha256, canonicalAttestationBytes, canonicalPriceTableSha256, fixedFixtureHash, frozenPlanSha256, pinnedReviewerNonce, pinnedWitnessHash, validateSanitizedLiveArtifact, validateTrustedLiveAcceptance, type SanitizedLiveAcceptanceArtifact, type TrustedLiveAttestation } from "../runner/live-acceptance.js";
import { currentImplementationBinding, historicalV3CanaryBinding } from "../runner/live-acceptance-pins.js";
import { syntheticTokenPricing } from "../runner/cost.js";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const hashes = { provider: digest("provider"), model: digest("model"), reviewer: digest("reviewer"), evidence: digest("evidence") };
const routes = { "task-simple-query": "simple_query", "task-bounded-read": "bounded_read", "task-implementation": "implementation", "task-debugging": "debugging", "task-high-risk-failure": "high_risk_failure", "task-other": "other" } as const;
const expected = { simple_query: "low", bounded_read: "medium", implementation: "high", debugging: "high", high_risk_failure: "xhigh", other: "high" } as const;
const independentWitnessSignature = "UHIv5ySqTLCqY7dl3YX/2mdSKUF4mXswN+O5gyTFAs2/ARPtKElOrL1blM23nq5m+PLTEIVX+jerHQ9r4Ya6Dg==";
const independentWitnessSignatureSha256 = "5c911f326c633f6d66098bbe20f676096998e2c8449f9e0441563c950e0799f7";
const artifact = (): SanitizedLiveAcceptanceArtifact => ({ schemaVersion: 2, capturedAt: "2026-07-26T00:00:00Z", providerFingerprint: hashes.provider, modelFingerprint: hashes.model, priceTableFingerprint: canonicalPriceTableSha256(syntheticTokenPricing), cacheObservability: { protocolVersion: 1, rawCachedTokensPresence: "observed", verdict: "PASS" }, runs: Object.entries(routes).flatMap(([taskId, routeCase]) => (["fixed-xhigh", "fixed-high", "policy-shadow", "policy-enforce"] as const).map((mode) => ({ taskId: taskId as keyof typeof routes, routeCase, highConfidence: routeCase === "simple_query" || routeCase === "bounded_read", highRisk: routeCase === "high_risk_failure", mode, repetition: 1 as const, selectedEffort: mode === "fixed-xhigh" ? "xhigh" : mode === "fixed-high" ? "high" : expected[routeCase], ...(mode === "policy-shadow" ? { baselinePayloadHash: digest(`baseline:${taskId}`), appliedPayloadHash: digest(`baseline:${taskId}`) } : { appliedEffort: mode === "fixed-xhigh" ? "xhigh" : mode === "fixed-high" ? "high" : expected[routeCase] }), providerRequests: 1, toolRounds: 1, retries: 0, usage: { inputTokens: 10, uncachedInputTokens: 5, outputTokens: 1, reasoningTokens: 1, cacheReadTokens: 5, cacheWriteTokens: 1 }, latencyMs: 1, effectiveCostMicros: 122, accepted: true, criticalFailure: false }))), cacheCrossover: structuredClone(syntheticCacheCrossover), reviews: [] });
const historicalV3Artifact = (): SanitizedLiveAcceptanceArtifact => {
  const controls = { modelHash: digest("synthetic-model"), providerHash: digest("synthetic-provider"), systemPromptHash: digest("synthetic-system"), toolSetHash: digest("synthetic-tools"), inputHash: digest("synthetic-input"), promptCacheKeyHash: digest("synthetic-cache-key"), cacheModeHash: digest("synthetic-cache-mode"), transportHash: digest("synthetic-transport"), historyHash: digest("synthetic-history") };
  const controlsFingerprint = createHash("sha256").update(JSON.stringify(Object.keys(controls).sort().reduce<Record<string, string>>((result, key) => ({ ...result, [key]: controls[key as keyof typeof controls] }), {}))).digest("hex");
  const usage = (uncachedInputTokens: number, outputTokens: number, reasoningTokens: number, cacheReadTokens: number, cacheWriteTokens: number) => ({ inputTokens: uncachedInputTokens + cacheReadTokens, uncachedInputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens });
  const sample = (id: string, effort: string, phase: string, values: ReturnType<typeof usage>, latencyMs: number) => ({ id, effort, phase, controlsFingerprint, providerRequests: 1, retries: 0, usage: values, latencyMs });
  const cacheCrossover = [
    { id: "A", controls, samples: [sample("A1", "high", "cold", usage(120, 20, 40, 0, 120), 100), sample("A2", "high", "warm", usage(0, 18, 35, 120, 0), 70), sample("A3", "low", "crossover", usage(0, 10, 10, 120, 0), 45)] },
    { id: "B", controls, samples: [sample("B1", "low", "cold", usage(120, 10, 10, 0, 120), 60), sample("B2", "low", "warm", usage(0, 9, 9, 120, 0), 40), sample("B3", "high", "crossover", usage(120, 18, 35, 0, 120), 95)] },
    { id: "C", controls, samples: [sample("C1", "xhigh", "cold", usage(120, 28, 60, 0, 120), 150), sample("C2", "xhigh", "warm", usage(0, 26, 55, 120, 0), 110), sample("C3", "medium", "crossover", usage(0, 14, 20, 120, 0), 65)] },
  ];
  return { ...artifact(), cacheCrossover: cacheCrossover as unknown as SanitizedLiveAcceptanceArtifact["cacheCrossover"] };
};
const unsigned = (value: SanitizedLiveAcceptanceArtifact): TrustedLiveAttestation => ({ artifactSha256: canonicalArtifactSha256(value), providerFingerprint: value.providerFingerprint, modelFingerprint: value.modelFingerprint, priceTableFingerprint: value.priceTableFingerprint, pricing: syntheticTokenPricing, ceilings: { maxProviderRequests: 33, maxInputTokens: 1321, maxOutputTokens: 178, maxReasoningTokens: 300, maxEffectiveCostMicros: 100000 }, witnessedAt: "2026-07-26T00:00:00Z", witnessHash: pinnedWitnessHash, reviewerNonce: pinnedReviewerNonce, planSha256: frozenPlanSha256, acceptedBaseSha256, sourceFingerprint: currentImplementationBinding.sourceFingerprint, extensionBuildFingerprint: currentImplementationBinding.extensionBuildFingerprint, issuedAt: "2026-07-26T00:00:00Z", expiresAt: "2026-07-26T01:00:00Z", signature: "AA==" });

describe("production-pinned sanitized live acceptance boundary", () => {
  it("rejects every critical policy-enforce row, even when fixed-xhigh also rejects", () => {
    const value = artifact(); const taskId = "task-high-risk-failure";
    const criticalBothFail = { ...value, runs: value.runs.map((run) => run.taskId === taskId && (run.mode === "fixed-xhigh" || run.mode === "policy-enforce") ? { ...run, accepted: false, criticalFailure: true } : run) };
    expect(() => validateSanitizedLiveArtifact(criticalBothFail, syntheticTokenPricing)).toThrow("critical policy-enforce");
    const acceptedCritical = { ...criticalBothFail, runs: criticalBothFail.runs.map((run) => run.taskId === taskId && run.mode === "policy-enforce" ? { ...run, accepted: true } : run) };
    expect(() => validateSanitizedLiveArtifact(acceptedCritical, syntheticTokenPricing)).toThrow("critical failure must reject");
  });

  it("permits only one reviewed, noncritical, fixed simple-query degradation", () => {
    const value = artifact(); const degraded = { ...value, runs: value.runs.map((run) => run.taskId === "task-simple-query" && run.mode === "policy-enforce" ? { ...run, accepted: false } : run) };
    const review = { runId: "task-simple-query:policy-enforce", taskId: "task-simple-query" as const, reviewerHash: hashes.reviewer, reviewedAt: "2026-07-26T00:00:00Z", reviewCode: "reject-noncritical-under-route" as const, evidenceHash: hashes.evidence, fixtureCode: "fixed-noncritical-simple-query" as const, fixtureHash: fixedFixtureHash("task-simple-query", "simple_query") };
    expect(() => validateSanitizedLiveArtifact({ ...degraded, reviews: [review] }, syntheticTokenPricing)).not.toThrow();
    expect(() => validateSanitizedLiveArtifact(degraded, syntheticTokenPricing)).toThrow("reviews must match");
    expect(() => validateSanitizedLiveArtifact({ ...degraded, reviews: [{ ...review, taskId: "task-other" }] }, syntheticTokenPricing)).toThrow("does not match");
    expect(() => validateSanitizedLiveArtifact({ ...degraded, reviews: [{ ...review, reviewCode: "accept" }] }, syntheticTokenPricing)).toThrow("invalid sanitized review");
    expect(() => validateSanitizedLiveArtifact({ ...degraded, reviews: [{ ...review, fixtureHash: hashes.provider }] }, syntheticTokenPricing)).toThrow("fixture semantics");
    const two = { ...degraded, runs: degraded.runs.map((run) => run.taskId === "task-bounded-read" && run.mode === "policy-enforce" ? { ...run, accepted: false } : run) };
    expect(() => validateSanitizedLiveArtifact({ ...two, reviews: [review] }, syntheticTokenPricing)).toThrow("live quality allowance");
  });

  it("rejects attacker keys, altered signed bindings, raw durable text, unknown keys, and invalid caps before trust", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-07-26T00:30:00Z")); const value = artifact(); const proof = unsigned(value);
    expect(() => validateTrustedLiveAcceptance(value, proof)).toThrow("not verified");
    expect(() => validateTrustedLiveAcceptance(value, { ...proof, witnessHash: hashes.provider })).toThrow("unpinned binding");
    expect(() => validateTrustedLiveAcceptance(value, { ...proof, reviewerNonce: hashes.provider })).toThrow("unpinned binding");
    expect(() => validateTrustedLiveAcceptance(value, { ...proof, planSha256: hashes.provider })).toThrow("unpinned binding");
    expect(() => validateTrustedLiveAcceptance(value, { ...proof, acceptedBaseSha256: hashes.provider })).toThrow("invalid accepted base binding");
    expect(() => validateTrustedLiveAcceptance(value, { ...proof, sourceFingerprint: hashes.provider })).toThrow("unpinned binding");
    expect(() => validateTrustedLiveAcceptance(value, { ...proof, extensionBuildFingerprint: hashes.provider })).toThrow("unpinned binding");
    expect(() => validateTrustedLiveAcceptance(value, { ...proof, publicKey: "attacker" })).toThrow("unknown");
    expect(() => validateSanitizedLiveArtifact({ ...value, providerFingerprint: "provider-name" }, syntheticTokenPricing)).toThrow("invalid hash");
    expect(() => validateSanitizedLiveArtifact({ ...value, runs: [{ ...value.runs[0], taskId: "arbitrary-task" }, ...value.runs.slice(1)] }, syntheticTokenPricing)).toThrow("invalid live run");
    expect(() => validateSanitizedLiveArtifact({ ...value, reviews: [{ runId: "task-simple-query:policy-enforce", taskId: "task-simple-query", reviewerHash: hashes.reviewer, reviewedAt: "2026-07-26T00:00:00Z", reviewCode: "reject-noncritical-under-route", evidenceHash: hashes.evidence, fixtureCode: "fixed-noncritical-simple-query", fixtureHash: fixedFixtureHash("task-simple-query", "simple_query"), rationale: "free text" }] }, syntheticTokenPricing)).toThrow("unknown");
    expect(() => validateTrustedLiveAcceptance(value, { ...proof, ceilings: { ...proof.ceilings, maxInputTokens: 1319 } })).toThrow("not verified"); vi.useRealTimers();
  });

  it("rejects immutable historical v3 bindings before synthetic signature verification", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-07-26T00:30:00Z"));
    try { expect(() => validateTrustedLiveAcceptance(artifact(), { ...unsigned(artifact()), ...historicalV3CanaryBinding })).toThrow("invalid accepted base binding"); }
    finally { vi.useRealTimers(); }
  });

  it("uses system time only and rejects old, future, and overlong windows", () => {
    const value = artifact(); const proof = unsigned(value); vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-26T00:30:00Z")); expect(() => validateTrustedLiveAcceptance(value, proof)).toThrow("not verified");
      expect(() => validateTrustedLiveAcceptance(value, { ...proof, issuedAt: "2026-07-26T02:00:00Z" })).toThrow("validity window");
      expect(() => validateTrustedLiveAcceptance(value, { ...proof, expiresAt: "2026-07-28T00:00:00Z" })).toThrow("validity window");
      expect(() => validateTrustedLiveAcceptance(value, { ...proof, expiresAt: "2026-07-26T00:15:00Z" })).toThrow("validity window");
      expect(() => validateTrustedLiveAcceptance(value, { ...proof, witnessedAt: "2026-07-25T23:59:59Z" })).toThrow("witnessedAt");
      expect(() => validateTrustedLiveAcceptance(value, { ...proof, witnessedAt: "2026-07-26T01:00:01Z" })).toThrow("witnessedAt");
    } finally { vi.useRealTimers(); }
  });

  it("binds canonical signed bytes without accepting a caller key or callback", () => {
    const value = artifact(); const proof = unsigned(value);
    expect(canonicalAttestationBytes(proof).toString()).not.toContain("signature");
    expect(() => validateTrustedLiveAcceptance({ ...value, capturedAt: "2026-07-26T00:00:01Z" }, proof)).toThrow("hash does not match");
    expect(() => validateTrustedLiveAcceptance(value, { ...proof, artifactSha256: hashes.provider })).toThrow("hash does not match");
  });

  it("retains negative cache-canary verdicts structurally but never trusts them for cache acceptance", () => {
    const value = artifact();
    for (const verdict of ["OBSERVABILITY_UNAVAILABLE", "ENVIRONMENT_UNQUALIFIED", "REGRESSION"] as const) {
      const negative = { ...value, cacheObservability: { protocolVersion: 1 as const, rawCachedTokensPresence: verdict === "OBSERVABILITY_UNAVAILABLE" ? "pi_normalized_presence_unknown" as const : "observed" as const, verdict } };
      expect(() => validateSanitizedLiveArtifact(negative, syntheticTokenPricing)).not.toThrow();
      expect(() => validateTrustedLiveAcceptance(negative, unsigned(negative))).toThrow("trusted cache acceptance");
    }
  });

  it("uses canonical hash-valued cache controls and permits only internally consistent per-group controls", () => {
    const groups = structuredClone(syntheticCacheCrossover);
    const controls = groups[0]!.controls;
    expect(cacheControlsFingerprint(controls)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => validateCacheCrossover([{ ...groups[0], controls: { ...controls, modelHash: "a|b" } }, ...groups.slice(1)])).toThrow("partial");
    const divergent = structuredClone(groups); divergent[1]!.controls = { ...controls, inputHash: digest("different-input") };
    const groupFingerprint = cacheControlsFingerprint(divergent[1]!.controls);
    divergent[1]!.samples = divergent[1]!.samples.map((sample) => ({ ...sample, controlsFingerprint: groupFingerprint })) as unknown as typeof divergent[1]["samples"];
    expect(() => validateCacheCrossover(divergent)).toThrow("partial");
    const raw = structuredClone(groups); (raw[0]!.controls as Record<string, unknown>).unknown = 300;
    expect(() => validateCacheCrossover(raw)).toThrow("unknown");
  });

  // Synthetic verifier fixture only; it is not a live v3 capture or signature.
  it("keeps the synthetic legacy witness fixture bytes immutable but rejects its stale binding", () => {
    const value = historicalV3Artifact(); const proof: TrustedLiveAttestation = { ...unsigned(value), ...historicalV3CanaryBinding, witnessedAt: "2026-07-27T00:01:14.852Z", issuedAt: "2026-07-27T00:01:14.852Z", expiresAt: "2026-07-27T00:51:14.852Z", signature: independentWitnessSignature };
    expect(canonicalArtifactSha256(value)).toBe("b620ba498c16f913d11ff1d49cf4632f3869de60d0938e687fbbc660bede0493");
    expect(createHash("sha256").update(canonicalAttestationBytes(proof)).digest("hex")).toBe("7d7d2e8be135acdf41de59ee3c56c5440303a5c7057ddb70d176cbbae3ea19f7");
    expect(createHash("sha256").update(Buffer.from(proof.signature, "base64")).digest("hex")).toBe(independentWitnessSignatureSha256);
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-07-27T00:30:00.000Z"));
    try {
      expect(() => validateTrustedLiveAcceptance(value, proof)).toThrow("invalid accepted base binding");
    } finally { vi.useRealTimers(); }
  });
});
