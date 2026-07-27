#!/usr/bin/env node
/** Writes reviewable unsigned canonical bytes; this script never reads or uses a signing key. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalArtifactSha256, canonicalAttestationBytes, canonicalPriceTableSha256, pinnedReviewerNonce, pinnedWitnessHash } from "../dist/eval/eval/runner/live-acceptance.js";
import { expectedExtensionBuildFingerprint, expectedSourceFingerprint } from "../dist/eval/eval/runner/live-acceptance-pins.js";
import { syntheticCacheCrossover } from "../dist/eval/eval/runner/cache-crossover.js";
import { syntheticTokenPricing } from "../dist/eval/eval/runner/cost.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const routes = { "task-simple-query": "simple_query", "task-bounded-read": "bounded_read", "task-implementation": "implementation", "task-debugging": "debugging", "task-high-risk-failure": "high_risk_failure", "task-other": "other" };
const effort = { simple_query: "low", bounded_read: "medium", implementation: "high", debugging: "high", high_risk_failure: "xhigh", other: "high" };
const version = process.argv[3] ?? "v2";
const issuedAt = version === "v3" ? new Date().toISOString() : "2026-07-26T00:00:00Z";
const expiresAt = version === "v3" ? new Date(Date.parse(issuedAt) + 50 * 60 * 1000).toISOString() : "2026-07-26T01:00:00Z";
const artifact = {
  schemaVersion: 2, capturedAt: "2026-07-26T00:00:00Z", providerFingerprint: hash("provider"), modelFingerprint: hash("model"), priceTableFingerprint: canonicalPriceTableSha256(syntheticTokenPricing),
  runs: Object.entries(routes).flatMap(([taskId, routeCase]) => ["fixed-xhigh", "fixed-high", "policy-shadow", "policy-enforce"].map((mode) => ({
    taskId, routeCase, highConfidence: routeCase === "simple_query" || routeCase === "bounded_read", highRisk: routeCase === "high_risk_failure", mode, repetition: 1,
    selectedEffort: mode === "fixed-xhigh" ? "xhigh" : mode === "fixed-high" ? "high" : effort[routeCase],
    ...(mode === "policy-shadow" ? { baselinePayloadHash: hash(`baseline:${taskId}`), appliedPayloadHash: hash(`baseline:${taskId}`) } : { appliedEffort: mode === "fixed-xhigh" ? "xhigh" : mode === "fixed-high" ? "high" : effort[routeCase] }),
    providerRequests: 1, toolRounds: 1, retries: 0, usage: { inputTokens: 10, uncachedInputTokens: 5, outputTokens: 1, reasoningTokens: 1, cacheReadTokens: 5, cacheWriteTokens: 1 }, latencyMs: 1, effectiveCostMicros: 122, accepted: true, criticalFailure: false,
  }))), cacheCrossover: syntheticCacheCrossover, reviews: [],
};
const attestation = {
  artifactSha256: canonicalArtifactSha256(artifact), providerFingerprint: artifact.providerFingerprint, modelFingerprint: artifact.modelFingerprint, priceTableFingerprint: artifact.priceTableFingerprint, pricing: syntheticTokenPricing,
  ceilings: { maxProviderRequests: 33, maxInputTokens: 1321, maxOutputTokens: 178, maxReasoningTokens: 300, maxEffectiveCostMicros: 100000 }, witnessedAt: issuedAt, witnessHash: pinnedWitnessHash, reviewerNonce: pinnedReviewerNonce, planSha256: "184c964814cd1752b89409fec352cafb11f8b1cffe91b55abb660b34dfb290f6", acceptedBaseSha256: "cbdbf256286ee7fb3d05e52ac7d702dfc0838ec6", sourceFingerprint: expectedSourceFingerprint, extensionBuildFingerprint: expectedExtensionBuildFingerprint, issuedAt, expiresAt, signature: "",
};
const output = resolve(process.argv[2] ?? "/private/tmp/pi-reap-pr6-witness"); mkdirSync(output, { recursive: true });
const bytes = canonicalAttestationBytes(attestation); writeFileSync(resolve(output, `positive-attestation-${version}.bin`), bytes);
const metadata = { schemaVersion: 2, unsigned: true, attestationSha256: hash(bytes), artifactSha256: attestation.artifactSha256, sourceFingerprint: attestation.sourceFingerprint, extensionBuildFingerprint: attestation.extensionBuildFingerprint, issuedAt, expiresAt, witnessedAt: attestation.witnessedAt, ceilings: attestation.ceilings, signingCommand: `openssl pkeyutl -sign -rawin -inkey <independent-ed25519-private-key> -in positive-attestation-${version}.bin -out positive-attestation-${version}.sig` };
writeFileSync(resolve(output, `positive-attestation-${version}.metadata.json`), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(JSON.stringify({ bytes: bytes.length, sha256: metadata.attestationSha256, artifactSha256: metadata.artifactSha256 }));
