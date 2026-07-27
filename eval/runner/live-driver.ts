import { createHash, timingSafeEqual } from "node:crypto";
import type { AutomaticEffort } from "../../src/domain/effort.js";
import type { RoutingDecision } from "../../src/domain/routing-decision.js";
import type { TaskClass } from "../../src/domain/task-epoch.js";
import { acceptedBaseSha256, fixedFixtureHash, frozenPlanSha256, type LiveMode, type LiveTaskId, type RouteCase, type SanitizedLiveAcceptanceArtifact, type SanitizedLiveRun, type SanitizedReview } from "./live-acceptance.js";
import { classify } from "../../src/policy/classifier.js";
import { extractFeatures } from "../../src/policy/features.js";
import { currentImplementationBinding } from "./live-acceptance-pins.js";
import { cacheControlsFingerprint, type CacheCrossoverGroup, type CacheCrossoverSample, type CacheExperimentControls } from "./cache-crossover.js";
import { classifyLiveCacheComparison, recordPiAssistantUsage, type LiveCacheVerdict } from "./live-observability.js";
import { canonicalPriceTableSha256, canonicalArtifactSha256, validateSanitizedLiveArtifact } from "./live-acceptance.js";
import { effectiveCostMicros, type TokenPricing } from "./cost.js";
import type { MeasuredUsage } from "./types.js";
import { cachePrefixTokenizerName, measureOfflineCachePrefix } from "./cache-prefix-tokenizer.js";

export const configuredProvider = "openai-codex";
export const configuredModel = "openai-codex/gpt-5.4-mini";
export const configuredApi = "openai-codex-responses";
export const exactTaskIds = ["task-simple-query", "task-bounded-read", "task-implementation", "task-debugging", "task-high-risk-failure", "task-other"] as const satisfies readonly LiveTaskId[];
export const exactModes = ["fixed-xhigh", "fixed-high", "policy-shadow", "policy-enforce"] as const satisfies readonly LiveMode[];
export const exactCacheIds = ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"] as const;
export const liveCaps = { maxProviderRequests: 33, maxRetries: 0, maxInputTokens: 70_000, maxOutputTokens: 10_000, maxReasoningTokens: 20_000, maxCacheWriteTokens: 20_000, maxMicroUsd: 250_000 } as const;
export const ceilingRatesMicroUsd = { uncachedInput: 1, cacheRead: 1, cacheWrite: 1, output: 5, reasoning: 5 } as const;
export const catalogPricing: TokenPricing = { uncachedInputMicrosPerToken: 0.75, outputMicrosPerToken: 4.5, reasoningMicrosPerToken: 0, cacheReadMicrosPerToken: 0.075, cacheWriteMicrosPerToken: 0 };
export const evaluationSystemPrompt = "Return only the requested final answer. Do not use tools.";
const cachePrimer = Array.from({ length: 1_100 }, () => "n").join(" ");
export const cacheEvaluationSystemPrompt = `${evaluationSystemPrompt}\n${cachePrimer}`;
export const captureWallClockMs = 120_000;
export const captureStreamByteLimit = 1_048_576;
export const minimumExactCachePrefixTokens = 1_024;

export interface RuntimeFingerprints {
  readonly piExecutableSha256: string;
  readonly piPackageSha256: string;
  readonly piCatalogSha256: string;
  readonly piPackageVersion: "0.82.1";
}
export interface CatalogModel extends RuntimeFingerprints {
  readonly id: string;
  readonly api: string;
  readonly reasoning: boolean;
  readonly ratesPerMillion: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
}
export interface ExactCachePrefixMeasurement {
  readonly schemaVersion: 1;
  readonly status: "measured";
  readonly method: "provider_compatible_exact_tokenizer";
  readonly provider: typeof configuredProvider;
  readonly model: typeof configuredModel;
  readonly api: typeof configuredApi;
  readonly commonPrefixSha256: string;
  readonly tokenCount: number;
  readonly cacheCallCount: 9;
  readonly tokenizerName: typeof cachePrefixTokenizerName;
  readonly tokenizerFingerprint: string;
}
export interface CachePrefixMeasurementUnavailable {
  readonly schemaVersion: 1;
  readonly status: "unavailable";
  readonly code: "provider_compatible_tokenizer_unavailable";
  readonly provider: typeof configuredProvider;
  readonly model: typeof configuredModel;
  readonly api: typeof configuredApi;
}
export type CachePrefixMeasurementCapability = ExactCachePrefixMeasurement | CachePrefixMeasurementUnavailable;
export interface PrivateTask {
  readonly id: LiveTaskId;
  readonly body: string;
  readonly grader: { readonly kind: "exact"; readonly expected: string };
}
export interface RoutePlannedCall {
  readonly schemaVersion: 1;
  readonly ordinal: number;
  readonly id: string;
  readonly kind: "route";
  readonly taskId: LiveTaskId;
  readonly mode: LiveMode;
  readonly taskHash: string;
  readonly extensionMode: "shadow" | "enforce";
  readonly baselineEffort?: "high" | "xhigh";
  readonly systemPromptHash: string;
  readonly sessionHash: string;
}
export interface CachePlannedCall {
  readonly schemaVersion: 1;
  readonly ordinal: number;
  readonly id: string;
  readonly kind: "cache";
  readonly taskId: "task-simple-query";
  readonly cacheId: (typeof exactCacheIds)[number];
  readonly group: "A" | "B" | "C";
  readonly phase: "cold" | "warm" | "crossover";
  readonly effort: AutomaticEffort;
  readonly taskHash: string;
  readonly extensionMode: "shadow";
  readonly systemPromptHash: string;
  readonly sessionHash: string;
}
export type PlannedCall = RoutePlannedCall | CachePlannedCall;
export interface CacheUsageProvenance {
  readonly schemaVersion: 1;
  readonly boundary: "pi_normalized_assistant_usage";
  readonly cachedTokensPresence: "pi_normalized_presence_unknown";
  readonly cacheWriteTokensPresence: "pi_normalized_presence_unknown";
  readonly normalizedCacheReadTokens: number;
  readonly normalizedCacheWriteTokens: number;
}
export interface AuthorizationEnvelope {
  readonly schemaVersion: 3;
  readonly provider: typeof configuredProvider;
  readonly model: typeof configuredModel;
  readonly api: typeof configuredApi;
  readonly caps: typeof liveCaps;
  readonly ceilingRates: typeof ceilingRatesMicroUsd;
  readonly catalogRates: CatalogModel["ratesPerMillion"];
  readonly runtime: RuntimeFingerprints;
  readonly sourceFingerprint: string;
  readonly extensionBuildFingerprint: string;
  readonly planSha256: string;
  readonly acceptedBaseSha256: string;
  readonly taskManifestSha256: string;
  readonly callPlanSha256: string;
  readonly cachePrefixMeasurement: ExactCachePrefixMeasurement;
}
interface LegacyAuthorizationEnvelope {
  readonly schemaVersion: 2;
  readonly provider: typeof configuredProvider;
  readonly model: typeof configuredModel;
  readonly api: typeof configuredApi;
  readonly caps: typeof liveCaps;
  readonly ceilingRates: typeof ceilingRatesMicroUsd;
  readonly catalogRates: CatalogModel["ratesPerMillion"];
  readonly runtime: RuntimeFingerprints;
  readonly sourceFingerprint: string;
  readonly extensionBuildFingerprint: string;
  readonly planSha256: string;
  readonly acceptedBaseSha256: string;
  readonly taskManifestSha256: string;
  readonly callPlanSha256: string;
}
export interface CapturedObservation {
  readonly call: PlannedCall;
  readonly selectedEffort: AutomaticEffort;
  readonly appliedEffort?: AutomaticEffort;
  readonly baselinePayload: unknown;
  readonly appliedPayload: unknown;
  readonly baselinePayloadHash: string;
  readonly appliedPayloadHash: string;
  readonly providerRequests: number;
  readonly responseAttempts: number;
  readonly retries: number;
  readonly toolRounds: number;
  readonly cacheUsageProvenance?: CacheUsageProvenance;
  readonly usage: MeasuredUsage;
  readonly latencyMs: number;
  readonly providerFingerprint: string;
  readonly modelFingerprint: string;
  readonly controlHashes: CacheExperimentControls;
  readonly output: string;
  readonly outputHash: string;
  readonly accepted: boolean;
  readonly criticalFailure: boolean;
  readonly catalogCostMicros: number;
  readonly ceilingCostMicros: number;
}
export interface CaptureAdapter {
  readonly estimate: (call: PlannedCall, task: PrivateTask) => MeasuredUsage;
  readonly execute: (call: PlannedCall, task: PrivateTask) => Promise<CapturedObservation>;
}
export type CaptureAdapterFactory = () => Promise<CaptureAdapter> | CaptureAdapter;
export type CaptureFailureCode =
  | "invalid_plan" | "adapter_factory" | "estimate_rejected" | "adapter_call" | "observation_rejected" | "cap_rejected" | "amplification" | "incomplete_capture"
  | "cache_crossover_no_cache_read" | "legacy_or_missing_exact_prefix_measurement" | "post_capture_finalization_failed";
export type CaptureFailurePhase = "capture" | "post_capture";
const postCaptureFailureCodes = new Set<CaptureFailureCode>(["cache_crossover_no_cache_read", "legacy_or_missing_exact_prefix_measurement", "post_capture_finalization_failed"]);
export class CaptureFailure extends Error {
  readonly name = "CaptureFailure";
  readonly phase: CaptureFailurePhase;
  constructor(readonly code: CaptureFailureCode, readonly completedCalls: number) {
    super(`live capture failed: ${code}`);
    this.phase = postCaptureFailureCodes.has(code) ? "post_capture" : "capture";
    const validCount = this.phase === "post_capture"
      ? completedCalls === liveCaps.maxProviderRequests
      : Number.isInteger(completedCalls) && completedCalls >= 0 && completedCalls < liveCaps.maxProviderRequests;
    if (!validCount) throw new Error("invalid capture failure phase or completed-call count");
  }
}
export class PreflightCapabilityError extends Error {
  readonly name = "PreflightCapabilityError";
  readonly code = "provider_compatible_tokenizer_unavailable";
  constructor() { super("provider-compatible exact cache-prefix token measurement is unavailable"); }
}
const verifiedPrivateCaptureBrand: unique symbol = Symbol("verified-private-capture");
export interface PrivateCaptureFile {
  readonly [verifiedPrivateCaptureBrand]: true;
  readonly schemaVersion: 2 | 3;
  readonly envelope: AuthorizationEnvelope | LegacyAuthorizationEnvelope;
  readonly authorizationDigest: string;
  readonly calls: readonly PlannedCall[];
  readonly captured: readonly CapturedObservation[];
  readonly cachePrefixMeasurement?: ExactCachePrefixMeasurement;
}
export interface PrivateReviewDecision {
  readonly runId: string;
  readonly taskId: LiveTaskId;
  readonly reviewer: string;
  readonly reviewedAt: string;
  readonly acceptance: "reject";
  readonly rationale: string;
  readonly fixtureCode: "fixed-noncritical-simple-query";
  readonly fixtureHash: string;
}

const routeByTask: Readonly<Record<LiveTaskId, string>> = { "task-simple-query": "simple_query", "task-bounded-read": "bounded_read", "task-implementation": "implementation", "task-debugging": "debugging", "task-high-risk-failure": "high_risk_failure", "task-other": "other" };
const initialRouteByTask: Readonly<Record<LiveTaskId, { readonly taskClass: TaskClass; readonly effort: AutomaticEffort }>> = {
  "task-simple-query": { taskClass: "simple_query", effort: "low" },
  "task-bounded-read": { taskClass: "bounded_read", effort: "medium" },
  "task-implementation": { taskClass: "implementation", effort: "high" },
  // The production lexical classifier groups an explicit debug request with
  // implementation; both classes share the frozen high-effort route.
  "task-debugging": { taskClass: "implementation", effort: "high" },
  "task-high-risk-failure": { taskClass: "high_risk", effort: "xhigh" },
  "task-other": { taskClass: "unknown", effort: "high" },
};
const cacheMatrix = [
  ["A1", "A", "cold", "high"], ["A2", "A", "warm", "high"], ["A3", "A", "crossover", "low"],
  ["B1", "B", "cold", "low"], ["B2", "B", "warm", "low"], ["B3", "B", "crossover", "high"],
  ["C1", "C", "cold", "xhigh"], ["C2", "C", "warm", "xhigh"], ["C3", "C", "crossover", "medium"],
] as const;

export function canonicalJson(value: unknown): string {
  if (value === undefined) fail("undefined is not canonical JSON");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
export function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
export function modelFingerprintForCatalog(catalog: CatalogModel): string {
  validateCatalog(catalog);
  return sha256(canonicalJson({ id: catalog.id, api: catalog.api, reasoning: catalog.reasoning, ratesPerMillion: catalog.ratesPerMillion }));
}
export function sessionIdForCall(call: PlannedCall): string { return `pr6-${call.sessionHash.slice(0, 48)}`; }
export function evaluationSystemPromptForCall(call: Pick<PlannedCall, "kind">): string {
  return call.kind === "cache" ? cacheEvaluationSystemPrompt : evaluationSystemPrompt;
}
export function expectedControlHashes(call: PlannedCall, task: PrivateTask, catalog: CatalogModel): CacheExperimentControls {
  const systemPromptHash = sha256(evaluationSystemPromptForCall(call));
  if (call.systemPromptHash !== systemPromptHash) fail("planned system prompt hash is invalid");
  return {
    modelHash: modelFingerprintForCatalog(catalog), providerHash: sha256(configuredProvider), systemPromptHash,
    toolSetHash: sha256("[]"), inputHash: sha256(task.body), promptCacheKeyHash: sha256(sessionIdForCall(call)),
    cacheModeHash: sha256("pi-session-id-default-retention/provider-managed-default-ttl"), transportHash: sha256("sse"), historyHash: sha256("[]"),
  };
}
export function taskManifestSha256(tasks: readonly PrivateTask[]): string { validatePrivateTasks(tasks); return sha256(canonicalJson(tasks)); }
export function exactCachePrefixMeasurement(): ExactCachePrefixMeasurement {
  const measurement = measureOfflineCachePrefix(cacheEvaluationSystemPrompt);
  if (measurement.tokenCount < minimumExactCachePrefixTokens || measurement.tokenCount > liveCaps.maxInputTokens) fail("exact cache prefix is outside the authorized token bounds");
  return deepFreeze({
    schemaVersion: 1, status: "measured", method: "provider_compatible_exact_tokenizer",
    provider: configuredProvider, model: configuredModel, api: configuredApi,
    commonPrefixSha256: measurement.commonPrefixSha256, tokenCount: measurement.tokenCount,
    cacheCallCount: exactCacheIds.length, tokenizerName: measurement.tokenizerName,
    tokenizerFingerprint: measurement.tokenizerFingerprint,
  }) as unknown as ExactCachePrefixMeasurement;
}
export function authorizationEnvelope(tasks: readonly PrivateTask[], catalog: CatalogModel, cachePrefixMeasurement: ExactCachePrefixMeasurement): AuthorizationEnvelope {
  validatePrivateTasks(tasks); validateCatalog(catalog);
  const calls = planCalls(tasks); const measurement = requireExactCachePrefixMeasurement(cachePrefixMeasurement);
  return {
    schemaVersion: 3, provider: configuredProvider, model: configuredModel, api: configuredApi, caps: liveCaps,
    ceilingRates: ceilingRatesMicroUsd, catalogRates: catalog.ratesPerMillion,
    runtime: { piExecutableSha256: catalog.piExecutableSha256, piPackageSha256: catalog.piPackageSha256, piCatalogSha256: catalog.piCatalogSha256, piPackageVersion: catalog.piPackageVersion },
    sourceFingerprint: currentImplementationBinding.sourceFingerprint, extensionBuildFingerprint: currentImplementationBinding.extensionBuildFingerprint,
    planSha256: frozenPlanSha256, acceptedBaseSha256, taskManifestSha256: taskManifestSha256(tasks), callPlanSha256: sha256(canonicalJson(calls)),
    cachePrefixMeasurement: measurement,
  };
}
function legacyAuthorizationEnvelope(tasks: readonly PrivateTask[], catalog: CatalogModel): LegacyAuthorizationEnvelope {
  validatePrivateTasks(tasks); validateCatalog(catalog);
  const calls = planCalls(tasks);
  return {
    schemaVersion: 2, provider: configuredProvider, model: configuredModel, api: configuredApi, caps: liveCaps,
    ceilingRates: ceilingRatesMicroUsd, catalogRates: catalog.ratesPerMillion,
    runtime: { piExecutableSha256: catalog.piExecutableSha256, piPackageSha256: catalog.piPackageSha256, piCatalogSha256: catalog.piCatalogSha256, piPackageVersion: catalog.piPackageVersion },
    sourceFingerprint: currentImplementationBinding.sourceFingerprint, extensionBuildFingerprint: currentImplementationBinding.extensionBuildFingerprint,
    planSha256: frozenPlanSha256, acceptedBaseSha256, taskManifestSha256: taskManifestSha256(tasks), callPlanSha256: sha256(canonicalJson(calls)),
  };
}
export function authorizationDigest(envelope: AuthorizationEnvelope): string { validateEnvelope(envelope); return sha256(canonicalJson(envelope)); }
export function validateCatalog(model: CatalogModel): void {
  if (model.id !== configuredModel || model.api !== configuredApi || model.reasoning !== true || model.piPackageVersion !== "0.82.1") fail("installed Pi catalog does not match the configured reasoning model");
  for (const value of [model.piExecutableSha256, model.piPackageSha256, model.piCatalogSha256]) hash(value, "Pi runtime");
  const rates = model.ratesPerMillion;
  if (rates.input !== 0.75 || rates.output !== 4.5 || rates.cacheRead !== 0.075 || rates.cacheWrite !== 0) fail("installed Pi catalog rates do not match configured model");
}
export function planCalls(tasks: readonly PrivateTask[]): readonly PlannedCall[] {
  validatePrivateTasks(tasks);
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const calls: PlannedCall[] = [];
  for (const taskId of exactTaskIds) {
    for (const mode of exactModes) {
      const task = taskMap.get(taskId)!; const ordinal = calls.length + 1;
      const baselineEffort = mode === "fixed-xhigh" ? "xhigh" : mode === "fixed-high" ? "high" : undefined;
      calls.push(Object.freeze({
        schemaVersion: 1, ordinal, id: `${taskId}:${mode}`, kind: "route", taskId, mode,
        taskHash: sha256(canonicalJson(task)), extensionMode: mode === "policy-enforce" ? "enforce" : "shadow",
        ...(baselineEffort ? { baselineEffort } : {}), systemPromptHash: sha256(evaluationSystemPrompt),
        sessionHash: sha256(`route-session:${ordinal}:${taskId}:${mode}`),
      }));
    }
  }
  const cacheTask = taskMap.get("task-simple-query")!;
  for (const [cacheId, group, phase, effort] of cacheMatrix) {
    const ordinal = calls.length + 1;
    calls.push(Object.freeze({
      schemaVersion: 1, ordinal, id: `cache:${cacheId}`, kind: "cache", taskId: "task-simple-query", cacheId, group, phase, effort,
      taskHash: sha256(canonicalJson(cacheTask)), extensionMode: "shadow", systemPromptHash: sha256(cacheEvaluationSystemPrompt),
      sessionHash: sha256(`cache-session:${group}`),
    }));
  }
  if (calls.length !== liveCaps.maxProviderRequests) fail("planned provider request count is not exactly 33");
  return Object.freeze(calls);
}
/** The authorization comparison is completed before any caller may create auth, session, or adapter state. */
export function preflight(
  execute: boolean,
  suppliedDigest: string | undefined,
  tasks: readonly PrivateTask[],
  catalog: CatalogModel,
  cachePrefixMeasurement: CachePrefixMeasurementCapability,
): { readonly calls: readonly PlannedCall[]; readonly envelope: AuthorizationEnvelope; readonly digest: string; readonly cachePrefixMeasurement: ExactCachePrefixMeasurement } {
  validatePrivateTasks(tasks);
  validateProductionInitialRoutes(tasks);
  const measuredPrefix = requireExactCachePrefixMeasurement(cachePrefixMeasurement);
  const calls = planCalls(tasks);
  if (execute && (typeof suppliedDigest !== "string" || !/^[a-f0-9]{64}$/.test(suppliedDigest))) fail("execute requires the exact authorization digest before adapter or authentication access");
  const envelope = authorizationEnvelope(tasks, catalog, measuredPrefix); const digest = authorizationDigest(envelope);
  if (execute && !safeDigestEqual(suppliedDigest, digest)) fail("execute requires the exact authorization digest before adapter or authentication access");
  validateCatalog(catalog);
  if (sha256(canonicalJson(calls)) !== envelope.callPlanSha256) fail("authorization call-plan binding is invalid");
  return Object.freeze({ calls, envelope, digest, cachePrefixMeasurement: measuredPrefix });
}

/** Deep-bound 33-call capture. The factory is not touched until every plan field passes. */
export async function captureAuthorized(calls: readonly PlannedCall[], tasks: readonly PrivateTask[], adapterFactory: CaptureAdapterFactory): Promise<readonly CapturedObservation[]> {
  let expected: readonly PlannedCall[];
  try {
    expected = planCalls(tasks);
    if (canonicalJson(calls) !== canonicalJson(expected)) throw new Error("plan mismatch");
  } catch { throw new CaptureFailure("invalid_plan", 0); }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const total = { requests: 0, input: 0, output: 0, reasoning: 0, cacheWrite: 0, microUsd: 0, retries: 0 };
  let adapter: CaptureAdapter;
  try { adapter = await adapterFactory(); } catch { throw new CaptureFailure("adapter_factory", 0); }
  const captured: CapturedObservation[] = [];
  try {
    for (const [index, call] of expected.entries()) {
      if (index !== captured.length || total.requests >= liveCaps.maxProviderRequests) throw new CaptureFailure("amplification", captured.length);
      const task = byId.get(call.taskId)!;
      let estimate: MeasuredUsage;
      try { estimate = adapter.estimate(call, task); validateUsage(estimate); } catch { throw new CaptureFailure("estimate_rejected", captured.length); }
      try { assertWithinCaps(total, estimate, 1, 0); } catch { throw new CaptureFailure("cap_rejected", captured.length); }
      let observation: CapturedObservation;
      try { observation = await adapter.execute(call, task); } catch { throw new CaptureFailure("adapter_call", captured.length); }
      try { validateObservation(observation, call, task); } catch { throw new CaptureFailure("observation_rejected", captured.length); }
      try { assertWithinCaps(total, observation.usage, observation.providerRequests, observation.retries); } catch { throw new CaptureFailure("cap_rejected", captured.length); }
      if (observation.providerRequests !== 1 || observation.responseAttempts !== 1 || observation.retries !== 0 || observation.toolRounds !== 0) throw new CaptureFailure("amplification", captured.length);
      addObservation(total, observation);
      captured.push(deepFreeze({ ...observation, call: { ...observation.call }, usage: { ...observation.usage }, controlHashes: { ...observation.controlHashes } }));
    }
  } catch (error) {
    throw error instanceof CaptureFailure ? error : new CaptureFailure("adapter_call", captured.length);
  }
  if (captured.length !== 33 || total.requests !== 33) throw new CaptureFailure("incomplete_capture", captured.length);
  return Object.freeze(captured);
}

/** Deterministic private grading and optional closed review binding produce only an unsigned schema-v2 artifact. */
export function finalizeUnsignedArtifact(verified: PrivateCaptureFile, tasks: readonly PrivateTask[], reviews: readonly PrivateReviewDecision[] = []): SanitizedLiveAcceptanceArtifact {
  if (verified[verifiedPrivateCaptureBrand] !== true) fail("finalize requires a verified private capture");
  if (verified.schemaVersion !== 3 || verified.cachePrefixMeasurement === undefined) {
    throw new CaptureFailure("legacy_or_missing_exact_prefix_measurement", liveCaps.maxProviderRequests);
  }
  requireExactCachePrefixMeasurement(verified.cachePrefixMeasurement);
  const { calls, captured } = verified;
  const expected = planCalls(tasks);
  if (canonicalJson(calls) !== canonicalJson(expected) || captured.length !== 33) fail("finalize requires the exact deep-bound 33-call capture");
  const byTask = new Map(tasks.map((task) => [task.id, task]));
  for (const [index, observation] of captured.entries()) validateObservation(observation, expected[index]!, byTask.get(expected[index]!.taskId)!);
  const providerFingerprint = one(captured.map((item) => item.providerFingerprint), "provider");
  const modelFingerprint = one(captured.map((item) => item.modelFingerprint), "model");
  const runs: SanitizedLiveRun[] = captured.slice(0, 24).map((item) => {
    const call = item.call; if (call.kind !== "route") fail("route capture order is invalid");
    const task = byTask.get(call.taskId)!; const route = routeByTask[call.taskId]! as RouteCase;
    const accepted = item.output === task.grader.expected;
    const criticalFailure = !accepted && call.taskId === "task-high-risk-failure";
    return {
      taskId: call.taskId, routeCase: route, highConfidence: route === "simple_query" || route === "bounded_read", highRisk: route === "high_risk_failure",
      mode: call.mode, repetition: 1 as const, selectedEffort: item.selectedEffort,
      ...(call.mode === "policy-shadow" ? { baselinePayloadHash: item.baselinePayloadHash, appliedPayloadHash: item.appliedPayloadHash } : { appliedEffort: item.appliedEffort! }),
      providerRequests: item.providerRequests, toolRounds: item.toolRounds, retries: item.retries, usage: item.usage, latencyMs: item.latencyMs,
      effectiveCostMicros: effectiveCostMicros(item.usage, catalogPricing), accepted, criticalFailure,
    };
  });
  const reviewRows = buildSanitizedReviews(runs, reviews);
  const cacheCrossover = buildCacheGroups(captured.slice(24));
  const artifact: SanitizedLiveAcceptanceArtifact = {
    schemaVersion: 2, capturedAt: new Date().toISOString(), providerFingerprint, modelFingerprint,
    priceTableFingerprint: canonicalPriceTableSha256(catalogPricing), cacheObservability: { protocolVersion: 1, rawCachedTokensPresence: "pi_normalized_presence_unknown", verdict: classifyVerifiedLiveCacheObservability(verified) }, runs, cacheCrossover, reviews: reviewRows,
  };
  validateSanitizedLiveArtifact(artifact, catalogPricing);
  void canonicalArtifactSha256(artifact);
  return deepFreeze(artifact);
}

/**
 * v3 captures observe Pi-normalized assistant usage only.  This deliberately
 * returns OBSERVABILITY_UNAVAILABLE until a provider raw-field seam exists;
 * normalized numeric zero is never reinterpreted as a proven provider miss.
 */
export function classifyVerifiedLiveCacheObservability(verified: PrivateCaptureFile): LiveCacheVerdict {
  if (verified[verifiedPrivateCaptureBrand] !== true) fail("cache observability requires a verified private capture");
  const cache = verified.captured.filter((item) => item.call.kind === "cache");
  if (cache.length !== 9) fail("cache observability requires the complete cache matrix");
  const byId = new Map(cache.map((item) => [(item.call as CachePlannedCall).cacheId, item]));
  return classifyLiveCacheComparison([
    { positiveControl: recordPiAssistantUsage({ cacheRead: byId.get("A2")!.usage.cacheReadTokens }), crossover: recordPiAssistantUsage({ cacheRead: byId.get("A3")!.usage.cacheReadTokens }) },
    { positiveControl: recordPiAssistantUsage({ cacheRead: byId.get("B2")!.usage.cacheReadTokens }), crossover: recordPiAssistantUsage({ cacheRead: byId.get("B3")!.usage.cacheReadTokens }) },
    { positiveControl: recordPiAssistantUsage({ cacheRead: byId.get("C2")!.usage.cacheReadTokens }), crossover: recordPiAssistantUsage({ cacheRead: byId.get("C3")!.usage.cacheReadTokens }) },
  ]);
}

/** The exact verify/finalize boundary used by the CLI. */
export function finalizePrivateCapture(
  captureValue: unknown,
  tasksValue: unknown,
  catalog: CatalogModel,
  reviews: readonly PrivateReviewDecision[] = [],
): SanitizedLiveAcceptanceArtifact {
  const verified = verifyPrivateCapture(captureValue, tasksValue, catalog);
  try {
    return finalizeUnsignedArtifact(verified, tasksValue as readonly PrivateTask[], reviews);
  } catch (error) {
    throw asPostCaptureFailure(error);
  }
}

/** Offline finalization boundary: rebinds all private evidence to current installed/runtime fingerprints. */
export function verifyPrivateCapture(value: unknown, tasksValue: unknown, catalog: CatalogModel): PrivateCaptureFile {
  validateCatalog(catalog);
  if (!isRecord(value)) fail("private capture must be an object");
  if (value.schemaVersion === 2) exactKeys(value, ["schemaVersion", "envelope", "authorizationDigest", "calls", "captured"], "private capture");
  else if (value.schemaVersion === 3) exactKeys(value, ["schemaVersion", "envelope", "authorizationDigest", "calls", "captured", "cachePrefixMeasurement"], "private capture");
  else fail("private capture header is invalid");
  if (!Array.isArray(value.calls) || !Array.isArray(value.captured)) fail("private capture header is invalid");
  const prefixMeasurement = value.schemaVersion === 3
    ? requireExactCachePrefixMeasurement(value.cachePrefixMeasurement as CachePrefixMeasurementCapability)
    : undefined;
  validatePrivateTasks(tasksValue as readonly PrivateTask[]);
  const tasks = tasksValue as readonly PrivateTask[];
  const expectedEnvelope = value.schemaVersion === 2
    ? legacyAuthorizationEnvelope(tasks, catalog)
    : authorizationEnvelope(tasks, catalog, prefixMeasurement!);
  if (canonicalJson(value.envelope) !== canonicalJson(expectedEnvelope)) fail("private capture authorization envelope is stale or altered");
  const expectedDigest = value.schemaVersion === 2
    ? sha256(canonicalJson(expectedEnvelope))
    : authorizationDigest(expectedEnvelope as AuthorizationEnvelope);
  if (!safeDigestEqual(value.authorizationDigest as string | undefined, expectedDigest)) fail("private capture authorization digest is invalid");
  const expectedCalls = planCalls(tasks);
  if (canonicalJson(value.calls) !== canonicalJson(expectedCalls)) fail("private capture call plan is altered");
  if (value.captured.length !== 33) fail("private capture observations are missing or duplicated");
  const total = { requests: 0, input: 0, output: 0, reasoning: 0, cacheWrite: 0, microUsd: 0, retries: 0 };
  const preservedCaptured: CapturedObservation[] = [];
  for (const [index, candidate] of value.captured.entries()) {
    const call = expectedCalls[index]!; const task = tasks.find((item) => item.id === call.taskId)!;
    const observation = value.schemaVersion === 2 && isRecord(candidate) && candidate.cacheUsageProvenance === undefined
      ? { ...candidate, cacheUsageProvenance: normalizedCacheUsageProvenance((candidate as unknown as CapturedObservation).usage) } as unknown as CapturedObservation
      : candidate as CapturedObservation;
    validateObservation(observation, call, task);
    if (observation.providerFingerprint !== sha256(configuredProvider) || observation.modelFingerprint !== modelFingerprintForCatalog(catalog)) fail("private capture provider or model fingerprint is invalid");
    if (canonicalJson(observation.controlHashes) !== canonicalJson(expectedControlHashes(call, task, catalog))) fail("private capture controls are stale or altered");
    if (observation.providerRequests !== 1 || observation.responseAttempts !== 1 || observation.retries !== 0 || observation.toolRounds !== 0) fail("private capture contains request amplification");
    assertWithinCaps(total, observation.usage, observation.providerRequests, observation.retries);
    addObservation(total, observation);
    preservedCaptured.push(candidate as CapturedObservation);
  }
  if (total.requests !== 33) fail("private capture provider request total is invalid");
  buildCacheGroups(preservedCaptured);
  return deepFreeze({
    [verifiedPrivateCaptureBrand]: true,
    schemaVersion: value.schemaVersion, envelope: expectedEnvelope, authorizationDigest: expectedDigest,
    calls: expectedCalls, captured: preservedCaptured, ...(prefixMeasurement ? { cachePrefixMeasurement: prefixMeasurement } : {}),
  });
}

export function privateReviewWorksheet(captured: readonly CapturedObservation[], tasks: readonly PrivateTask[]): readonly Record<string, unknown>[] {
  if (captured.length !== 33) fail("review worksheet requires a complete capture");
  const byTask = new Map(tasks.map((task) => [task.id, task]));
  const rows: Record<string, unknown>[] = [];
  for (const taskId of exactTaskIds) {
    const baseline = captured.find((item) => item.call.kind === "route" && item.call.taskId === taskId && item.call.mode === "fixed-xhigh")!;
    const policy = captured.find((item) => item.call.kind === "route" && item.call.taskId === taskId && item.call.mode === "policy-enforce")!;
    const task = byTask.get(taskId)!;
    if (baseline.output === task.grader.expected && policy.output !== task.grader.expected) {
      rows.push({ runId: `${taskId}:policy-enforce`, taskId, baselineOutputHash: baseline.outputHash, policyOutputHash: policy.outputHash, selectedEffort: policy.selectedEffort, requiredFixtureHash: fixedFixtureHash(taskId, routeByTask[taskId] as RouteCase) });
    }
  }
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

export function sanitizedDryRun(calls: readonly PlannedCall[], envelope: AuthorizationEnvelope, digest: string, cachePrefixMeasurement: ExactCachePrefixMeasurement): Record<string, unknown> {
  const measurement = requireExactCachePrefixMeasurement(cachePrefixMeasurement);
  if (canonicalJson(envelope.cachePrefixMeasurement) !== canonicalJson(measurement)) fail("dry-run cache prefix measurement is not authorization-bound");
  return {
    schemaVersion: 3, dryRun: true, providerHash: sha256(envelope.provider), modelHash: sha256(envelope.model),
    taskManifestSha256: envelope.taskManifestSha256, callPlanSha256: envelope.callPlanSha256, authorizationDigest: digest,
    runtime: envelope.runtime, sourceFingerprint: envelope.sourceFingerprint, extensionBuildFingerprint: envelope.extensionBuildFingerprint,
    planSha256: envelope.planSha256, acceptedBaseSha256: envelope.acceptedBaseSha256,
    cachePrefixMeasurement: measurement,
    routeCallIds: calls.filter((call) => call.kind === "route").map((call) => call.id), cacheCallIds: calls.filter((call) => call.kind === "cache").map((call) => call.id),
    caps: envelope.caps, ceilingRates: envelope.ceilingRates, catalogRates: envelope.catalogRates,
  };
}

export function requireExactCachePrefixMeasurement(value: CachePrefixMeasurementCapability): ExactCachePrefixMeasurement {
  if (!isRecord(value) || value.status !== "measured") throw new PreflightCapabilityError();
  exactKeys(value, ["schemaVersion", "status", "method", "provider", "model", "api", "commonPrefixSha256", "tokenCount", "cacheCallCount", "tokenizerName", "tokenizerFingerprint"], "cache prefix measurement");
  if (value.schemaVersion !== 1 || value.method !== "provider_compatible_exact_tokenizer" || value.provider !== configuredProvider ||
    value.model !== configuredModel || value.api !== configuredApi || value.cacheCallCount !== exactCacheIds.length ||
    value.tokenizerName !== cachePrefixTokenizerName || !Number.isInteger(value.tokenCount) ||
    value.tokenCount < minimumExactCachePrefixTokens || value.tokenCount > liveCaps.maxInputTokens) fail("cache prefix measurement is invalid");
  hash(value.commonPrefixSha256, "cache prefix");
  hash(value.tokenizerFingerprint, "cache prefix tokenizer");
  if (canonicalJson(value) !== canonicalJson(exactCachePrefixMeasurement())) fail("cache prefix measurement does not match the pinned prefix boundary and tokenizer");
  return deepFreeze({ ...value }) as unknown as ExactCachePrefixMeasurement;
}

export function asPostCaptureFailure(error: unknown): CaptureFailure {
  if (error instanceof CaptureFailure && error.phase === "post_capture") return error;
  return new CaptureFailure("post_capture_finalization_failed", liveCaps.maxProviderRequests);
}

export function normalizedCacheUsageProvenance(usage: Pick<MeasuredUsage, "cacheReadTokens" | "cacheWriteTokens">): CacheUsageProvenance {
  for (const value of [usage.cacheReadTokens, usage.cacheWriteTokens]) if (!Number.isInteger(value) || value < 0) fail("normalized cache usage is invalid");
  return Object.freeze({
    schemaVersion: 1, boundary: "pi_normalized_assistant_usage",
    cachedTokensPresence: "pi_normalized_presence_unknown", cacheWriteTokensPresence: "pi_normalized_presence_unknown",
    normalizedCacheReadTokens: usage.cacheReadTokens, normalizedCacheWriteTokens: usage.cacheWriteTokens,
  });
}

export function validatePrivateTasks(tasks: readonly PrivateTask[]): void {
  if (!Array.isArray(tasks) || tasks.length !== exactTaskIds.length) fail("private task input must contain exactly six tasks");
  for (const [index, unknownTask] of tasks.entries()) {
    if (!isRecord(unknownTask)) fail("private task input is invalid");
    exactKeys(unknownTask, ["id", "body", "grader"], "private task");
    if (unknownTask.id !== exactTaskIds[index] || typeof unknownTask.body !== "string" || unknownTask.body.length === 0 || Buffer.byteLength(unknownTask.body) > 4096 || unknownTask.body.includes("\0")) fail("private task input is invalid");
    if (!isRecord(unknownTask.grader)) fail("private grader is invalid");
    exactKeys(unknownTask.grader, ["kind", "expected"], "private grader");
    if (unknownTask.grader.kind !== "exact" || typeof unknownTask.grader.expected !== "string" || unknownTask.grader.expected.length === 0 || Buffer.byteLength(unknownTask.grader.expected) > 4096 || unknownTask.grader.expected.includes("\0")) fail("private grader is invalid");
  }
  const plannedBytes = tasks.reduce((sum, task) => sum + Buffer.byteLength(task.body) * 4, 0)
    + Buffer.byteLength(tasks[0]!.body) * 9
    + Buffer.byteLength(evaluationSystemPrompt) * 24
    + Buffer.byteLength(cacheEvaluationSystemPrompt) * 9;
  if (plannedBytes > liveCaps.maxInputTokens) fail("private task input exceeds the conservative input-token cap");
}

/**
 * Replays the actual production initial routing path while still offline.
 * Every private task gets a fresh router, matching the live driver's fresh
 * in-memory session boundary and preventing prior-epoch floors from masking a
 * fixture that does not exercise its frozen route.
 */
export function validateProductionInitialRoutes(tasks: readonly PrivateTask[]): void {
  validatePrivateTasks(tasks);
  for (const task of tasks) {
    const classified = classify({ features: extractFeatures({ prompt: task.body, source: "extension" }), relation: "new", previousFailed: false, resumeGuard: false });
    validateProductionInitialDecision(task.id, { relation: "new", taskClass: classified.taskClass, selectedEffort: initialRouteByTask[task.id].effort });
  }
}

/** Pure assertion seam for adversarial class/effort validation coverage. */
export function validateProductionInitialDecision(taskId: LiveTaskId, decision: Pick<RoutingDecision, "relation" | "taskClass"> & { readonly selectedEffort: AutomaticEffort }): void {
  const expected = initialRouteByTask[taskId];
  if (decision.relation !== "new" || decision.taskClass !== expected.taskClass || decision.selectedEffort !== expected.effort) {
    fail(`private task ${taskId} does not match the frozen production initial route (${decision.taskClass}/${decision.selectedEffort} selected; ${expected.taskClass}/${expected.effort} required)`);
  }
}

function buildCacheGroups(items: readonly CapturedObservation[]): readonly CacheCrossoverGroup[] {
  const groups: CacheCrossoverGroup[] = [];
  for (const id of ["A", "B", "C"] as const) {
    const selected = items.filter((item) => item.call.kind === "cache" && item.call.group === id);
    if (selected.length !== 3) fail("cache capture matrix is incomplete");
    const controls = selected[0]!.controlHashes;
    if (selected.some((item) => canonicalJson(item.controlHashes) !== canonicalJson(controls))) fail(`cache group ${id} changed frozen controls`);
    const controlsFingerprint = cacheControlsFingerprint(controls);
    const samples = selected.map((item): CacheCrossoverSample => {
      const call = item.call as CachePlannedCall;
      return { id: call.cacheId, rung: { rungId: call.effort, ordinal: 0, providerValue: call.effort }, effort: call.effort, phase: call.phase, controlsFingerprint, providerRequests: item.providerRequests, retries: item.retries, usage: item.usage, latencyMs: item.latencyMs };
    }) as unknown as CacheCrossoverGroup["samples"];
    groups.push({ id, controls, samples });
  }
  return groups;
}
function buildSanitizedReviews(runs: readonly { taskId: LiveTaskId; mode: LiveMode; accepted: boolean; criticalFailure: boolean }[], reviews: readonly PrivateReviewDecision[]): readonly SanitizedReview[] {
  const degradations = runs.filter((run) => run.mode === "policy-enforce" && !run.accepted && runs.some((candidate) => candidate.taskId === run.taskId && candidate.mode === "fixed-xhigh" && candidate.accepted));
  if (reviews.length !== degradations.length) {
    if (degradations.length > 0) fail("finalize requires a closed private review for every under-route");
    if (reviews.length > 0) fail("finalize received review rows without an under-route");
  }
  return reviews.map((review) => {
    exactPrivateReview(review);
    const degradation = degradations.find((run) => `${run.taskId}:policy-enforce` === review.runId);
    if (!degradation || degradation.taskId !== review.taskId || degradation.criticalFailure || review.taskId !== "task-simple-query" || review.fixtureHash !== fixedFixtureHash("task-simple-query", "simple_query")) fail("private review or fixed fixture binding is invalid");
    return { runId: review.runId, taskId: review.taskId, reviewerHash: sha256(review.reviewer), reviewedAt: review.reviewedAt, reviewCode: "reject-noncritical-under-route", evidenceHash: sha256(review.rationale), fixtureCode: review.fixtureCode, fixtureHash: review.fixtureHash };
  });
}
function exactPrivateReview(review: PrivateReviewDecision): void {
  if (!isRecord(review)) fail("private review is invalid");
  exactKeys(review, ["runId", "taskId", "reviewer", "reviewedAt", "acceptance", "rationale", "fixtureCode", "fixtureHash"], "private review");
  if (!review.reviewer || !review.rationale || review.acceptance !== "reject" || review.fixtureCode !== "fixed-noncritical-simple-query" || !Number.isFinite(Date.parse(review.reviewedAt))) fail("private review is invalid");
}
function validateEnvelope(value: AuthorizationEnvelope): void {
  exactKeys(value as unknown as Record<string, unknown>, [
    "schemaVersion", "provider", "model", "api", "caps", "ceilingRates", "catalogRates", "runtime",
    "sourceFingerprint", "extensionBuildFingerprint", "planSha256", "acceptedBaseSha256",
    "taskManifestSha256", "callPlanSha256", "cachePrefixMeasurement",
  ], "authorization envelope");
  if (value.schemaVersion !== 3 || value.provider !== configuredProvider || value.model !== configuredModel || value.api !== configuredApi ||
    value.sourceFingerprint !== currentImplementationBinding.sourceFingerprint || value.extensionBuildFingerprint !== currentImplementationBinding.extensionBuildFingerprint ||
    value.planSha256 !== frozenPlanSha256 || value.acceptedBaseSha256 !== acceptedBaseSha256 ||
    canonicalJson(value.caps) !== canonicalJson(liveCaps) || canonicalJson(value.ceilingRates) !== canonicalJson(ceilingRatesMicroUsd) ||
    canonicalJson(value.catalogRates) !== canonicalJson({ input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 })) fail("authorization envelope has unpinned content");
  requireExactCachePrefixMeasurement(value.cachePrefixMeasurement);
  for (const valueToHash of [value.taskManifestSha256, value.callPlanSha256, value.runtime.piExecutableSha256, value.runtime.piPackageSha256, value.runtime.piCatalogSha256]) hash(valueToHash, "authorization");
  if (value.runtime.piPackageVersion !== "0.82.1") fail("authorization Pi version is invalid");
}
function validateObservation(value: CapturedObservation, call: PlannedCall, task: PrivateTask): void {
  if (!isRecord(value)) fail("adapter observation must be an object");
  exactKeysOptional(value, ["call", "selectedEffort", "baselinePayload", "appliedPayload", "baselinePayloadHash", "appliedPayloadHash", "providerRequests", "responseAttempts", "retries", "toolRounds", "cacheUsageProvenance", "usage", "latencyMs", "providerFingerprint", "modelFingerprint", "controlHashes", "output", "outputHash", "accepted", "criticalFailure", "catalogCostMicros", "ceilingCostMicros"], ["appliedEffort"], "adapter observation");
  if (canonicalJson(value.call) !== canonicalJson(call)) fail("adapter returned an observation for an unplanned call");
  validateUsage(value.usage); for (const candidate of [value.providerFingerprint, value.modelFingerprint, value.baselinePayloadHash, value.appliedPayloadHash, value.outputHash]) hash(candidate, "capture");
  validateCacheUsageProvenance(value.cacheUsageProvenance, value.usage);
  const baselineCanonical = canonicalJson(value.baselinePayload); const appliedCanonical = canonicalJson(value.appliedPayload);
  if (value.baselinePayloadHash !== sha256(baselineCanonical) || value.appliedPayloadHash !== sha256(appliedCanonical)) fail("adapter payload hash evidence is invalid");
  if (canonicalJson(withoutReasoningEffort(value.baselinePayload)) !== canonicalJson(withoutReasoningEffort(value.appliedPayload))) fail("provider payload changed outside reasoning.effort");
  if (value.outputHash !== sha256(value.output) || !Number.isFinite(value.latencyMs) || value.latencyMs < 0) fail("adapter output or latency evidence is invalid");
  for (const count of [value.providerRequests, value.responseAttempts, value.retries, value.toolRounds]) if (!Number.isInteger(count) || count < 0) fail("adapter counters are invalid");
  const expectedSelected = selectedEffort(call); if (value.selectedEffort !== expectedSelected) fail("adapter did not observe the planned selected effort");
  if (call.kind === "route" && call.mode === "policy-shadow") {
    if (value.appliedEffort !== undefined || appliedCanonical !== baselineCanonical) fail("shadow mode changed the provider payload");
  } else if (value.appliedEffort !== expectedSelected || effortInPayload(value.appliedPayload) !== expectedSelected) fail("adapter did not apply the planned effort");
  if (!isRecord(value.controlHashes)) fail("adapter control hashes are invalid");
  cacheControlsFingerprint(value.controlHashes);
  const accepted = value.output === task.grader.expected; const criticalFailure = !accepted && task.id === "task-high-risk-failure";
  if (value.accepted !== accepted || value.criticalFailure !== criticalFailure) fail("adapter grade evidence is invalid");
  if (value.catalogCostMicros !== effectiveCostMicros(value.usage, catalogPricing) || value.ceilingCostMicros !== ceilingCost(value.usage)) fail("adapter cost evidence is invalid");
}
function validateCacheUsageProvenance(value: unknown, usage: MeasuredUsage): void {
  if (!isRecord(value)) fail("cache usage provenance is invalid");
  exactKeys(value, ["schemaVersion", "boundary", "cachedTokensPresence", "cacheWriteTokensPresence", "normalizedCacheReadTokens", "normalizedCacheWriteTokens"], "cache usage provenance");
  if (value.schemaVersion !== 1 || value.boundary !== "pi_normalized_assistant_usage" ||
    value.cachedTokensPresence !== "pi_normalized_presence_unknown" || value.cacheWriteTokensPresence !== "pi_normalized_presence_unknown" ||
    value.normalizedCacheReadTokens !== usage.cacheReadTokens || value.normalizedCacheWriteTokens !== usage.cacheWriteTokens) fail("cache usage provenance is invalid");
}
function selectedEffort(call: PlannedCall): AutomaticEffort {
  if (call.kind === "cache") return call.effort;
  if (call.mode === "fixed-xhigh") return "xhigh"; if (call.mode === "fixed-high") return "high";
  return initialRouteByTask[call.taskId].effort;
}
function validateUsage(value: unknown): asserts value is MeasuredUsage {
  if (!isRecord(value)) fail("capture usage is invalid");
  exactKeys(value, ["inputTokens", "uncachedInputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens"], "capture usage");
  for (const item of Object.values(value)) if (typeof item !== "number" || !Number.isInteger(item) || item < 0) fail("capture usage is invalid");
  const measured: MeasuredUsage = { inputTokens: value.inputTokens as number, uncachedInputTokens: value.uncachedInputTokens as number, outputTokens: value.outputTokens as number, reasoningTokens: value.reasoningTokens as number, cacheReadTokens: value.cacheReadTokens as number, cacheWriteTokens: value.cacheWriteTokens as number };
  if (measured.inputTokens !== measured.uncachedInputTokens + measured.cacheReadTokens) fail("capture input token accounting is invalid");
}
function addObservation(total: { requests: number; input: number; output: number; reasoning: number; cacheWrite: number; microUsd: number; retries: number }, observation: CapturedObservation): void {
  total.requests += observation.providerRequests; total.input += observation.usage.inputTokens; total.output += observation.usage.outputTokens;
  total.reasoning += observation.usage.reasoningTokens; total.cacheWrite += observation.usage.cacheWriteTokens; total.retries += observation.retries;
  total.microUsd += ceilingCost(observation.usage);
}
function assertWithinCaps(total: { requests: number; input: number; output: number; reasoning: number; cacheWrite: number; microUsd: number; retries: number }, usage: MeasuredUsage, requests: number, retries: number): void {
  if (retries !== 0 || total.retries !== 0 || total.requests + requests > liveCaps.maxProviderRequests || total.input + usage.inputTokens > liveCaps.maxInputTokens ||
    total.output + usage.outputTokens > liveCaps.maxOutputTokens || total.reasoning + usage.reasoningTokens > liveCaps.maxReasoningTokens ||
    total.cacheWrite + usage.cacheWriteTokens > liveCaps.maxCacheWriteTokens || total.microUsd + ceilingCost(usage) > liveCaps.maxMicroUsd) fail("capture cap or retry guard rejected before scheduling the next call");
}
function ceilingCost(usage: MeasuredUsage): number {
  return usage.uncachedInputTokens * ceilingRatesMicroUsd.uncachedInput + usage.cacheReadTokens * ceilingRatesMicroUsd.cacheRead +
    usage.cacheWriteTokens * ceilingRatesMicroUsd.cacheWrite + usage.outputTokens * ceilingRatesMicroUsd.output + usage.reasoningTokens * ceilingRatesMicroUsd.reasoning;
}
function effortInPayload(payload: unknown): AutomaticEffort | undefined {
  if (!isRecord(payload) || !isRecord(payload.reasoning)) return undefined;
  const effort = payload.reasoning.effort;
  return typeof effort === "string" && ["low", "medium", "high", "xhigh"].includes(effort) ? effort as AutomaticEffort : undefined;
}
function withoutReasoningEffort(payload: unknown): unknown {
  if (!isRecord(payload) || !isRecord(payload.reasoning) || !("effort" in payload.reasoning)) return payload;
  const { effort: _effort, ...reasoning } = payload.reasoning;
  return { ...payload, reasoning };
}
function safeDigestEqual(supplied: string | undefined, expected: string): boolean {
  if (typeof supplied !== "string" || !/^[a-f0-9]{64}$/.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"));
}
function one(values: readonly string[], name: string): string { const unique = new Set(values); if (unique.size !== 1) fail(`capture has inconsistent ${name} fingerprints`); return values[0]!; }
function hash(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail(`${name} hash is invalid`); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void { if (Object.keys(value).length !== expected.length || Object.keys(value).some((key) => !expected.includes(key)) || expected.some((key) => !(key in value))) fail(`${name} has unknown, missing, or undefined keys`); }
function exactKeysOptional(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], name: string): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key) || value[key] === undefined) || required.some((key) => !(key in value))) fail(`${name} has unknown, missing, or undefined keys`);
}
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item); } return value; }
function fail(message: string): never { throw new Error(message); }
export const routeForTask = routeByTask;
