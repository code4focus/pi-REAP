import { createHash, createPublicKey, verify } from "node:crypto";
import type { AutomaticEffort } from "../../src/domain/effort.js";
import { cacheControlsFingerprint, validateCacheCrossover, type CacheCrossoverGroup, type Sha256 } from "./cache-crossover.js";
import { effectiveCostMicros, type TokenPricing } from "./cost.js";
import { currentImplementationBinding } from "./live-acceptance-pins.js";
import type { MeasuredUsage } from "./types.js";
import type { LiveCacheVerdict } from "./live-observability.js";

export type LiveTaskId = "task-simple-query" | "task-bounded-read" | "task-implementation" | "task-debugging" | "task-high-risk-failure" | "task-other";
export type RouteCase = "simple_query" | "bounded_read" | "implementation" | "debugging" | "high_risk_failure" | "other";
export type LiveMode = "fixed-xhigh" | "fixed-high" | "policy-shadow" | "policy-enforce";
export type ReviewCode = "reject-noncritical-under-route";
export type FixtureCode = "fixed-noncritical-simple-query";
const modes: readonly LiveMode[] = ["fixed-xhigh", "fixed-high", "policy-shadow", "policy-enforce"];
const tasks: Readonly<Record<LiveTaskId, RouteCase>> = { "task-simple-query": "simple_query", "task-bounded-read": "bounded_read", "task-implementation": "implementation", "task-debugging": "debugging", "task-high-risk-failure": "high_risk_failure", "task-other": "other" };
const efforts: readonly AutomaticEffort[] = ["low", "medium", "high", "xhigh"];
export const pinnedWitnessPublicKey = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA9wzd/U+UeerCqYsHNyimuNfGG2Tmi2XI233FeVAPJbU=\n-----END PUBLIC KEY-----\n";
export const pinnedWitnessSpkiSha256 = "b3240ab44e021c1bd2027f0d771f4ebdb9c6b55405643dc68c960e94af3e4eef";
export const pinnedWitnessHash = pinnedWitnessSpkiSha256;
export const pinnedReviewerNonce = "e55e26c20c6c9b734e80f4607b06afff6bcefefd4142470d7e211cfb27ff9026";
export const frozenPlanSha256 = "184c964814cd1752b89409fec352cafb11f8b1cffe91b55abb660b34dfb290f6";
export const acceptedBaseSha256 = currentImplementationBinding.acceptedBaseSha256;

export interface SanitizedLiveRun {
  readonly taskId: LiveTaskId; readonly routeCase: RouteCase; readonly highConfidence: boolean; readonly highRisk: boolean; readonly mode: LiveMode; readonly repetition: 1;
  readonly selectedEffort: AutomaticEffort; readonly appliedEffort?: AutomaticEffort; readonly baselinePayloadHash?: Sha256; readonly appliedPayloadHash?: Sha256;
  readonly providerRequests: number; readonly toolRounds: number; readonly retries: number; readonly usage: MeasuredUsage; readonly latencyMs: number; readonly effectiveCostMicros: number; readonly accepted: boolean; readonly criticalFailure: boolean;
}
export interface SanitizedReview { readonly runId: string; readonly taskId: LiveTaskId; readonly reviewerHash: Sha256; readonly reviewedAt: string; readonly reviewCode: ReviewCode; readonly evidenceHash: Sha256; readonly fixtureCode: FixtureCode; readonly fixtureHash: Sha256 }
export interface SanitizedCacheObservability { readonly protocolVersion: 1; readonly rawCachedTokensPresence: "observed" | "pi_normalized_presence_unknown"; readonly verdict: LiveCacheVerdict }
export interface SanitizedLiveAcceptanceArtifact { readonly schemaVersion: 2; readonly capturedAt: string; readonly providerFingerprint: Sha256; readonly modelFingerprint: Sha256; readonly priceTableFingerprint: Sha256; readonly cacheObservability: SanitizedCacheObservability; readonly runs: readonly SanitizedLiveRun[]; readonly cacheCrossover: readonly CacheCrossoverGroup[]; readonly reviews: readonly SanitizedReview[]; }
export interface TrustedLiveAttestation {
  readonly artifactSha256: Sha256; readonly providerFingerprint: Sha256; readonly modelFingerprint: Sha256; readonly priceTableFingerprint: Sha256; readonly pricing: TokenPricing;
  readonly ceilings: { readonly maxProviderRequests: 33; readonly maxInputTokens: number; readonly maxOutputTokens: number; readonly maxReasoningTokens: number; readonly maxEffectiveCostMicros: number };
  readonly witnessedAt: string; readonly witnessHash: Sha256; readonly reviewerNonce: Sha256; readonly planSha256: Sha256; readonly acceptedBaseSha256: Sha256; readonly sourceFingerprint: Sha256; readonly extensionBuildFingerprint: Sha256; readonly issuedAt: string; readonly expiresAt: string; readonly signature: string;
}
export interface TrustedLiveAcceptanceReceipt { readonly artifactSha256: Sha256; readonly sourceFingerprint: Sha256; readonly extensionBuildFingerprint: Sha256; readonly witnessedAt: string; readonly expiresAt: string; readonly providerRequests: 33; }

/** Process-local fail-closed challenge consumption. Cross-process completion is documented with the witness artifact. */
let pinnedChallengeConsumed = false;

export function canonicalArtifactSha256(artifact: SanitizedLiveAcceptanceArtifact): Sha256 { return sha256(canonicalJson(artifact)); }
export function canonicalPriceTableSha256(pricing: TokenPricing): Sha256 { validatePricing(pricing); return sha256(canonicalJson(pricing)); }
/** Detached signature material: exactly all attestation fields except signature, serialized canonically. */
export function canonicalAttestationBytes(attestation: TrustedLiveAttestation): Buffer { const { signature: _signature, ...material } = attestation; return Buffer.from(canonicalJson(material)); }
export function canonicalRunId(taskId: LiveTaskId, mode: LiveMode): string { return `${taskId}:${mode}`; }
export function fixedFixtureHash(taskId: LiveTaskId, routeCase: RouteCase): Sha256 { return sha256(canonicalJson({ fixtureCode: "fixed-noncritical-simple-query", routeCase, taskId })); }

/** Structural validation only: it contains no prompt, model, reviewer, or evidence text. */
export function validateSanitizedLiveArtifact(value: unknown, pricing: TokenPricing): SanitizedLiveAcceptanceArtifact {
  const artifact = record(value, "artifact"); exactKeys(artifact, artifactKeys, "artifact");
  if (artifact.schemaVersion !== 2 || !timestamp(artifact.capturedAt)) fail("invalid artifact header");
  for (const key of ["providerFingerprint", "modelFingerprint", "priceTableFingerprint"] as const) hash(artifact[key], key);
  if (!Array.isArray(artifact.runs) || !Array.isArray(artifact.cacheCrossover) || !Array.isArray(artifact.reviews)) fail("artifact collections must be arrays"); validateCacheObservability(artifact.cacheObservability);
  const runs = artifact.runs.map((run) => validateRun(run, pricing)); const cacheCrossover = artifact.cacheCrossover as CacheCrossoverGroup[]; validateCacheCrossover(cacheCrossover); validateCacheCosts(cacheCrossover, pricing);
  const reviews = artifact.reviews.map(validateReview); validateLiveMatrix(runs, reviews);
  return artifact as unknown as SanitizedLiveAcceptanceArtifact;
}

/** Production boundary: only the pinned witness, system time, and local pins are authoritative. */
export function validateTrustedLiveAcceptance(value: unknown, suppliedAttestation: unknown): TrustedLiveAcceptanceReceipt {
  rejectUndefined(value); rejectUndefined(suppliedAttestation);
  const attestation = deepFreeze(attestationCopy(suppliedAttestation)); validateAttestation(attestation);
  const artifact = deepFreeze(validateSanitizedLiveArtifact(canonicalCopy(value), attestation.pricing));
  if (artifact.cacheObservability.verdict !== "PASS" || artifact.cacheObservability.rawCachedTokensPresence !== "observed") fail("trusted cache acceptance requires qualified raw-observed PASS evidence");
  if (canonicalArtifactSha256(artifact) !== attestation.artifactSha256) fail("trusted attestation hash does not match artifact");
  if (artifact.providerFingerprint !== attestation.providerFingerprint || artifact.modelFingerprint !== attestation.modelFingerprint || artifact.priceTableFingerprint !== attestation.priceTableFingerprint) fail("trusted attestation metadata does not match artifact");
  if (attestation.witnessHash !== pinnedWitnessHash || attestation.reviewerNonce !== pinnedReviewerNonce || attestation.planSha256 !== frozenPlanSha256 || !hasCurrentImplementationBinding(attestation)) fail("trusted attestation has an unpinned binding (not current)");
  const now = Date.now(); const issued = Date.parse(attestation.issuedAt); const expires = Date.parse(attestation.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now || now > expires || expires - issued > 86_400_000) fail("attestation validity window is invalid");
  const witnessed = Date.parse(attestation.witnessedAt); if (!Number.isFinite(witnessed) || witnessed < issued || witnessed > expires) fail("witnessedAt is outside the attestation validity window");
  const spki = sha256(createPublicKey(pinnedWitnessPublicKey).export({ type: "spki", format: "der" })); if (spki !== pinnedWitnessSpkiSha256) fail("pinned witness SPKI fingerprint mismatch");
  const signature = base64(attestation.signature); if (!verify(null, canonicalAttestationBytes(attestation), pinnedWitnessPublicKey, signature)) fail("detached trusted attestation signature was not verified");
  validateCeilings(artifact, attestation);
  if (pinnedChallengeConsumed) fail("trusted attestation challenge replayed");
  pinnedChallengeConsumed = true;
  return deepFreeze({ artifactSha256: attestation.artifactSha256, sourceFingerprint: attestation.sourceFingerprint, extensionBuildFingerprint: attestation.extensionBuildFingerprint, witnessedAt: attestation.witnessedAt, expiresAt: attestation.expiresAt, providerRequests: 33 });
}

function validateRun(value: unknown, pricing: TokenPricing): SanitizedLiveRun {
  const run = record(value, "run"); exactKeys(run, requiredRunKeys, "run", optionalRunKeys);
  if (!isTaskId(run.taskId) || tasks[run.taskId] !== run.routeCase || !modes.includes(run.mode as LiveMode) || run.repetition !== 1 || !isEffort(run.selectedEffort)) fail("invalid live run route, task, mode, effort, or repetition");
  if (typeof run.highConfidence !== "boolean" || typeof run.highRisk !== "boolean" || typeof run.accepted !== "boolean" || typeof run.criticalFailure !== "boolean") fail("invalid live run booleans");
  if (run.criticalFailure && run.accepted) fail("critical failure must reject"); if (run.appliedEffort !== undefined && !isEffort(run.appliedEffort)) fail("invalid applied effort");
  for (const key of ["baselinePayloadHash", "appliedPayloadHash"] as const) if (run[key] !== undefined) hash(run[key], key);
  integer(run.providerRequests, "providerRequests", 1); integer(run.toolRounds, "toolRounds", 0); integer(run.retries, "retries", 0); if (run.retries > run.providerRequests || run.toolRounds > run.providerRequests + run.retries) fail("incoherent request counters");
  const usage = validateUsage(run.usage); finite(run.latencyMs, "latencyMs"); finite(run.effectiveCostMicros, "effectiveCostMicros"); if (effectiveCostMicros(usage, pricing) !== run.effectiveCostMicros) fail("effective cost does not match attested price table");
  return run as unknown as SanitizedLiveRun;
}
function validateUsage(value: unknown): MeasuredUsage { const usage = record(value, "usage"); exactKeys(usage, usageKeys, "usage"); for (const key of usageKeys) integer(usage[key], key, 0); const typed = { inputTokens: usage.inputTokens as number, uncachedInputTokens: usage.uncachedInputTokens as number, outputTokens: usage.outputTokens as number, reasoningTokens: usage.reasoningTokens as number, cacheReadTokens: usage.cacheReadTokens as number, cacheWriteTokens: usage.cacheWriteTokens as number }; if (typed.inputTokens !== typed.uncachedInputTokens + typed.cacheReadTokens) fail("input token accounting is inconsistent"); return typed; }
function validateLiveMatrix(runs: readonly SanitizedLiveRun[], reviews: readonly SanitizedReview[]): void {
  if (runs.length !== 24) fail("live matrix requires exactly 24 run rows"); const byKey = new Map<string, SanitizedLiveRun>();
  for (const run of runs) {
    const key = canonicalRunId(run.taskId, run.mode); if (byKey.has(key)) fail("duplicate live matrix row"); byKey.set(key, run);
    const expected = routeEffort(run.routeCase); if ((run.routeCase === "simple_query" || run.routeCase === "bounded_read") !== run.highConfidence || (run.routeCase === "high_risk_failure") !== run.highRisk) fail("live route risk/confidence contract violated");
    if (run.mode === "fixed-xhigh" && (run.selectedEffort !== "xhigh" || run.appliedEffort !== "xhigh")) fail("fixed-xhigh contract violated");
    if (run.mode === "fixed-high" && (run.selectedEffort !== "high" || run.appliedEffort !== "high")) fail("fixed-high contract violated");
    if (run.mode === "policy-shadow" && (run.selectedEffort !== expected || run.baselinePayloadHash === undefined || run.appliedPayloadHash !== run.baselinePayloadHash || run.appliedEffort !== undefined)) fail("policy-shadow baseline identity contract violated");
    if (run.mode === "policy-enforce" && (run.selectedEffort !== expected || run.appliedEffort !== expected)) fail("policy-enforce frozen route contract violated");
  }
  for (const taskId of Object.keys(tasks) as LiveTaskId[]) for (const mode of modes) if (!byKey.has(canonicalRunId(taskId, mode))) fail("live matrix has missing row");
  const degradations: SanitizedLiveRun[] = [];
  for (const taskId of Object.keys(tasks) as LiveTaskId[]) { const policy = byKey.get(canonicalRunId(taskId, "policy-enforce"))!; const baseline = byKey.get(canonicalRunId(taskId, "fixed-xhigh"))!; if (policy.criticalFailure) fail("critical policy-enforce failure rejects the live matrix"); if (baseline.accepted && !policy.accepted) degradations.push(policy); }
  if (degradations.length > 1 || degradations.some((run) => run.criticalFailure)) fail("live quality allowance failed");
  if (reviews.length !== degradations.length) fail("reviews must match exactly the noncritical degradation set"); const seen = new Set<string>();
  for (const review of reviews) { if (seen.has(review.runId)) fail("duplicate sanitized review"); seen.add(review.runId); const run = byKey.get(review.runId); if (!run || run.mode !== "policy-enforce" || run.taskId !== review.taskId || !degradations.includes(run)) fail("sanitized review does not match a degradation"); if (review.reviewCode !== "reject-noncritical-under-route" || review.fixtureCode !== "fixed-noncritical-simple-query" || run.taskId !== "task-simple-query" || run.routeCase !== "simple_query" || review.fixtureHash !== fixedFixtureHash(run.taskId, run.routeCase)) fail("sanitized review has invalid noncritical fixture semantics"); }
}
function validateReview(value: unknown): SanitizedReview { const review = record(value, "review"); exactKeys(review, reviewKeys, "review"); if (typeof review.runId !== "string" || !isTaskId(review.taskId) || !timestamp(review.reviewedAt) || review.reviewCode !== "reject-noncritical-under-route" || review.fixtureCode !== "fixed-noncritical-simple-query") fail("invalid sanitized review"); hash(review.reviewerHash, "reviewerHash"); hash(review.evidenceHash, "evidenceHash"); hash(review.fixtureHash, "fixtureHash"); return review as unknown as SanitizedReview; }
function validateCacheCosts(groups: readonly CacheCrossoverGroup[], pricing: TokenPricing): void { for (const group of groups) { hash(cacheControlsFingerprint(group.controls), "cache controls fingerprint"); for (const sample of group.samples) { const usage = validateUsage(sample.usage); finite(sample.latencyMs, "cache latency"); effectiveCostMicros(usage, pricing); } } }
function validateCacheObservability(value: unknown): asserts value is SanitizedCacheObservability { const observation = record(value, "cache observability"); exactKeys(observation, ["protocolVersion", "rawCachedTokensPresence", "verdict"], "cache observability"); if (observation.protocolVersion !== 1 || (observation.rawCachedTokensPresence !== "observed" && observation.rawCachedTokensPresence !== "pi_normalized_presence_unknown") || !["PASS", "REGRESSION", "ENVIRONMENT_UNQUALIFIED", "OBSERVABILITY_UNAVAILABLE"].includes(observation.verdict as string)) fail("invalid cache observability"); if (observation.rawCachedTokensPresence === "pi_normalized_presence_unknown" && observation.verdict !== "OBSERVABILITY_UNAVAILABLE") fail("unknown raw presence requires observability-unavailable verdict"); if (observation.verdict === "PASS" && observation.rawCachedTokensPresence !== "observed") fail("PASS requires observed raw cache presence"); }
function validateAttestation(value: TrustedLiveAttestation): void { const input = record(value, "attestation"); exactKeys(input, attestationKeys, "attestation"); for (const key of ["artifactSha256", "providerFingerprint", "modelFingerprint", "priceTableFingerprint", "witnessHash", "reviewerNonce", "planSha256", "sourceFingerprint", "extensionBuildFingerprint"] as const) hash(value[key], key); if (value.acceptedBaseSha256 !== acceptedBaseSha256) fail("invalid accepted base binding"); if (!timestamp(value.witnessedAt) || !timestamp(value.issuedAt) || !timestamp(value.expiresAt)) fail("invalid attestation timestamp"); if (typeof value.signature !== "string" || value.signature.length === 0) fail("invalid trusted attestation signature"); base64(value.signature); validatePricing(value.pricing); if (value.priceTableFingerprint !== canonicalPriceTableSha256(value.pricing)) fail("attested price table fingerprint does not match pricing"); const ceilings = record(value.ceilings, "attestation ceilings"); exactKeys(ceilings, ceilingKeys, "attestation ceilings"); if (value.ceilings.maxProviderRequests !== 33) fail("live provider-request ceiling must be 33"); for (const key of ceilingKeys) finite(value.ceilings[key], `attestation ceiling ${key}`); }
function hasCurrentImplementationBinding(value: Pick<TrustedLiveAttestation, "acceptedBaseSha256" | "sourceFingerprint" | "extensionBuildFingerprint">): boolean { return value.acceptedBaseSha256 === currentImplementationBinding.acceptedBaseSha256 && value.sourceFingerprint === currentImplementationBinding.sourceFingerprint && value.extensionBuildFingerprint === currentImplementationBinding.extensionBuildFingerprint; }
function validatePricing(pricing: TokenPricing): void { const input = record(pricing, "pricing"); exactKeys(input, pricingKeys, "pricing"); for (const key of pricingKeys) { const rate = pricing[key]; if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) fail("pricing rates must be non-negative finite numbers"); } if (pricing.uncachedInputMicrosPerToken === 0 || pricing.outputMicrosPerToken === 0) fail("input and output pricing rates must be positive"); }
function validateCeilings(artifact: SanitizedLiveAcceptanceArtifact, attestation: TrustedLiveAttestation): void { const cache = artifact.cacheCrossover.flatMap((group) => group.samples); const all = [...artifact.runs.map((run) => run.usage), ...cache.map((sample) => validateUsage(sample.usage))]; const sums = all.reduce((total, usage) => ({ input: total.input + usage.inputTokens, output: total.output + usage.outputTokens, reasoning: total.reasoning + usage.reasoningTokens }), { input: 0, output: 0, reasoning: 0 }); const requests = artifact.runs.reduce((total, run) => total + run.providerRequests, 0) + cache.reduce((total, sample) => total + (sample.providerRequests ?? 1), 0); const retries = artifact.runs.reduce((total, run) => total + run.retries, 0) + cache.reduce((total, sample) => total + (sample.retries ?? 0), 0); const cost = artifact.runs.reduce((total, run) => total + run.effectiveCostMicros, 0) + cache.reduce((total, sample) => total + effectiveCostMicros(validateUsage(sample.usage), attestation.pricing), 0); if (requests !== 33 || retries !== 0 || sums.input > attestation.ceilings.maxInputTokens || sums.output > attestation.ceilings.maxOutputTokens || sums.reasoning > attestation.ceilings.maxReasoningTokens || cost > attestation.ceilings.maxEffectiveCostMicros) fail("trusted live acceptance exceeds bounded matrix or ceiling"); }
function routeEffort(route: RouteCase): AutomaticEffort { return route === "simple_query" ? "low" : route === "bounded_read" ? "medium" : route === "high_risk_failure" ? "xhigh" : "high"; }
function isTaskId(value: unknown): value is LiveTaskId { return typeof value === "string" && value in tasks; }
function isEffort(value: unknown): value is AutomaticEffort { return typeof value === "string" && efforts.includes(value as AutomaticEffort); }
function record(value: unknown, name: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${name} must be an object`); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, required: readonly string[], name: string, optional: readonly string[] = []): void { const allowed = new Set([...required, ...optional]); if (Object.keys(value).some((key) => !allowed.has(key) || value[key] === undefined) || required.some((key) => !(key in value))) fail(`${name} has unknown, missing, or undefined keys`); }
function hash(value: unknown, name: string): asserts value is Sha256 { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail(`invalid hash ${name}`); }
function base64(value: string): Buffer { if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail("invalid base64 signature"); return Buffer.from(value, "base64"); }
function integer(value: unknown, name: string, min: number): asserts value is number { if (typeof value !== "number" || !Number.isInteger(value) || value < min) fail(`invalid integer ${name}`); }
function finite(value: unknown, name: string): asserts value is number { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(`invalid finite ${name}`); }
function timestamp(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)); }
function rejectUndefined(value: unknown): void { if (value === undefined) fail("undefined is not canonical JSON"); if (Array.isArray(value)) for (const item of value) rejectUndefined(item); else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) rejectUndefined(item); }
function canonicalCopy(value: unknown): unknown { return JSON.parse(canonicalJson(value)); }
function attestationCopy(value: unknown): TrustedLiveAttestation { return canonicalCopy(value) as TrustedLiveAttestation; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item); } return value; }
function sha256(value: string | Buffer): Sha256 { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; const object = value as Record<string, unknown>; return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`; }
function fail(message: string): never { throw new Error(message); }
const artifactKeys = ["schemaVersion", "capturedAt", "providerFingerprint", "modelFingerprint", "priceTableFingerprint", "cacheObservability", "runs", "cacheCrossover", "reviews"] as const;
const optionalRunKeys = ["appliedEffort", "baselinePayloadHash", "appliedPayloadHash"] as const;
const requiredRunKeys = ["taskId", "routeCase", "highConfidence", "highRisk", "mode", "repetition", "selectedEffort", "providerRequests", "toolRounds", "retries", "usage", "latencyMs", "effectiveCostMicros", "accepted", "criticalFailure"] as const;
const reviewKeys = ["runId", "taskId", "reviewerHash", "reviewedAt", "reviewCode", "evidenceHash", "fixtureCode", "fixtureHash"] as const;
const pricingKeys = ["uncachedInputMicrosPerToken", "outputMicrosPerToken", "reasoningMicrosPerToken", "cacheReadMicrosPerToken", "cacheWriteMicrosPerToken"] as const;
const ceilingKeys = ["maxProviderRequests", "maxInputTokens", "maxOutputTokens", "maxReasoningTokens", "maxEffectiveCostMicros"] as const;
const attestationKeys = ["artifactSha256", "providerFingerprint", "modelFingerprint", "priceTableFingerprint", "pricing", "ceilings", "witnessedAt", "witnessHash", "reviewerNonce", "planSha256", "acceptedBaseSha256", "sourceFingerprint", "extensionBuildFingerprint", "issuedAt", "expiresAt", "signature"] as const;
const usageKeys = ["inputTokens", "uncachedInputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
