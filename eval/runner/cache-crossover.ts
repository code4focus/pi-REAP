import { createHash } from "node:crypto";
import { canonicalProfileDigest } from "../../src/domain/canonical-json.js";
import { createProfileBinding, type ProfileBinding, type ProfileMatch } from "../../src/domain/profile.js";
import { profileFixtures } from "../corpus/manifest.js";
import { effectiveCostMicros, generationCostMicros, syntheticTokenPricing, type TokenPricing } from "./cost.js";
import type { UsageMetrics } from "./types.js";

export type Sha256 = string;
export type RawCacheReadObservation =
  | { readonly status: "present"; readonly value: number }
  | { readonly status: "unobservable" };

/**
 * Successor controls are exact profile/environment bindings. Legacy hashes are
 * retained only so immutable v3 receipts can still be parsed; they never
 * qualify a successor cache gate.
 */
export interface CacheExperimentControls {
  readonly capabilityProfileId?: string;
  readonly capabilityProfileRevision?: string;
  readonly capabilityProfileDigest?: string;
  readonly admissionProfileId?: string;
  readonly admissionProfileRevision?: string;
  readonly admissionProfileDigest?: string;
  readonly provider?: string;
  readonly api?: string;
  readonly model?: string;
  readonly modelCatalogRevision?: string;
  readonly modelCatalogDigest?: string;
  readonly piVersion?: string;
  readonly providerAdapterRevision?: string;
  readonly providerAdapterDigest?: string;
  readonly protocolDigest?: Sha256;
  readonly authorizationDigest?: Sha256;
  readonly systemPromptFingerprint?: string;
  readonly toolSetFingerprint?: string;
  readonly inputFingerprint?: string;
  readonly promptCacheKeyFingerprint?: string;
  readonly cacheMode?: string;
  readonly ttlSeconds?: number;
  readonly transport?: string;
  readonly historyFingerprint?: string;
  readonly modelHash?: Sha256;
  readonly providerHash?: Sha256;
  readonly apiHash?: Sha256;
  readonly systemPromptHash?: Sha256;
  readonly toolSetHash?: Sha256;
  readonly inputHash?: Sha256;
  readonly promptCacheKeyHash?: Sha256;
  readonly cacheModeHash?: Sha256;
  readonly transportHash?: Sha256;
  readonly historyHash?: Sha256;
}
export interface CacheCrossoverSample {
  readonly id: string;
  readonly rung?: { readonly rungId: string; readonly ordinal: number; readonly providerValue: string };
  readonly phase: "cold" | "warm" | "crossover";
  readonly usage: UsageMetrics;
  readonly latencyMs: number;
  readonly rawCacheRead?: RawCacheReadObservation;
  /** Immutable v3 receipt-only fields. */
  readonly providerRequests?: number;
  readonly retries?: number;
  readonly effort?: string;
  readonly controlsFingerprint?: Sha256;
}
export interface CacheCrossoverGroup {
  readonly id: "A" | "B" | "C";
  readonly controls: CacheExperimentControls;
  readonly samples: readonly [CacheCrossoverSample, CacheCrossoverSample, CacheCrossoverSample];
}
export type CacheCrossoverVerdict = "PASS" | "REGRESSION" | "ENVIRONMENT_UNQUALIFIED" | "OBSERVABILITY_UNAVAILABLE";
export interface DerivedCacheQualification {
  readonly groupsDigest: Sha256;
  readonly profileBindingDigest?: Sha256;
  readonly environmentDigest?: Sha256;
  readonly protocolDigest?: Sha256;
  readonly authorizationDigest?: Sha256;
  readonly rawFieldObservability: "observed" | "unavailable";
  readonly positiveControlCachedTokens?: number;
  readonly crossoverCachedTokens?: number;
  readonly verdict: CacheCrossoverVerdict;
  readonly binding?: Pick<ProfileBinding, "capability" | "admission" | "match">;
}

const successorControlKeys = [
  "capabilityProfileId", "capabilityProfileRevision", "capabilityProfileDigest",
  "admissionProfileId", "admissionProfileRevision", "admissionProfileDigest",
  "provider", "api", "model", "modelCatalogRevision", "modelCatalogDigest",
  "piVersion", "providerAdapterRevision", "providerAdapterDigest",
  "protocolDigest", "authorizationDigest", "systemPromptFingerprint",
  "toolSetFingerprint", "inputFingerprint", "promptCacheKeyFingerprint",
  "cacheMode", "ttlSeconds", "transport", "historyFingerprint",
] as const;
const legacyControlKeys = [
  "modelHash", "providerHash", "systemPromptHash", "toolSetHash", "inputHash",
  "promptCacheKeyHash", "cacheModeHash", "transportHash", "historyHash",
] as const;
const usageKeys = ["inputTokens", "uncachedInputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens"] as const;

const profile = profileFixtures.multiRung;
const binding = createProfileBinding(profile.capability, profile.admission);
if (!binding.ok) throw new Error("synthetic cache profile must bind");
const controls: CacheExperimentControls = {
  capabilityProfileId: binding.binding.capability.profileId,
  capabilityProfileRevision: binding.binding.capability.profileRevision,
  capabilityProfileDigest: binding.binding.capability.profileDigest,
  admissionProfileId: binding.binding.admission.profileId,
  admissionProfileRevision: binding.binding.admission.profileRevision,
  admissionProfileDigest: binding.binding.admission.profileDigest,
  provider: profile.capability.match.provider,
  api: profile.capability.match.api,
  model: profile.capability.match.model,
  modelCatalogRevision: profile.capability.match.modelCatalogRevision,
  modelCatalogDigest: profile.capability.match.modelCatalogDigest,
  piVersion: profile.capability.match.piVersion,
  providerAdapterRevision: profile.capability.match.providerAdapterRevision,
  providerAdapterDigest: profile.capability.match.providerAdapterDigest,
  protocolDigest: createHash("sha256").update("synthetic-cache-protocol-v1").digest("hex"),
  authorizationDigest: createHash("sha256").update("synthetic-cache-authorization-v1").digest("hex"),
  systemPromptFingerprint: "synthetic-system-v1",
  toolSetFingerprint: "synthetic-tools-v1",
  inputFingerprint: "synthetic-input-v1",
  promptCacheKeyFingerprint: "synthetic-cache-key-v1",
  cacheMode: "explicit",
  ttlSeconds: 300,
  transport: "synthetic",
  historyFingerprint: "synthetic-history-v1",
};
const usage = (uncachedInputTokens: number, outputTokens: number, reasoningTokens: number, cacheReadTokens: number, cacheWriteTokens: number): UsageMetrics => ({ inputTokens: uncachedInputTokens + cacheReadTokens, uncachedInputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens });
const rung = (id: string): NonNullable<CacheCrossoverSample["rung"]> => {
  const value = profile.capability.rungs.find((candidate) => candidate.id === id);
  if (!value || typeof value.providerValue !== "string") throw new Error(`missing or non-string synthetic cache rung ${id}`);
  return { rungId: value.id, ordinal: value.ordinal, providerValue: value.providerValue };
};
const sample = (id: string, rungId: string, phase: CacheCrossoverSample["phase"], values: UsageMetrics, latencyMs: number): CacheCrossoverSample => ({ id, rung: rung(rungId), phase, usage: values, latencyMs });

/** Synthetic normalized-only fixtures. They can exercise plumbing, never claim live PASS. */
export const syntheticCacheCrossover: readonly CacheCrossoverGroup[] = [
  { id: "A", controls, samples: [sample("A1", "high", "cold", usage(120, 20, 40, 0, 120), 100), sample("A2", "high", "warm", usage(0, 18, 35, 120, 0), 70), sample("A3", "low", "crossover", usage(0, 10, 10, 120, 0), 45)] },
  { id: "B", controls, samples: [sample("B1", "low", "cold", usage(120, 10, 10, 0, 120), 60), sample("B2", "low", "warm", usage(0, 9, 9, 120, 0), 40), sample("B3", "high", "crossover", usage(120, 18, 35, 0, 120), 95)] },
  { id: "C", controls, samples: [sample("C1", "max-auto", "cold", usage(120, 28, 60, 0, 120), 150), sample("C2", "max-auto", "warm", usage(0, 26, 55, 120, 0), 110), sample("C3", "mid", "crossover", usage(0, 14, 20, 120, 0), 65)] },
];

export interface CrossoverAssessment {
  readonly sameEffortWarmHit: boolean;
  readonly crossoverRead: boolean;
  readonly crossoverWrite: boolean;
  readonly coldCostMicros: number;
  readonly warmCostMicros: number;
  readonly crossoverCostMicros: number;
  readonly reducedGenerationCostMicros: number;
  readonly addedCacheWriteCostMicros: number;
  readonly generationSavingsExceedAddedWrite: boolean;
}
export function assessCrossover(group: CacheCrossoverGroup, pricing: TokenPricing = syntheticTokenPricing): CrossoverAssessment {
  const [cold, warm, crossover] = group.samples;
  const coldGeneration = generationCostMicros(cold.usage, pricing);
  const crossoverGeneration = generationCostMicros(crossover.usage, pricing);
  const reducedGenerationCostMicros = coldGeneration - crossoverGeneration;
  const addedCacheWriteCostMicros = requiredUsage(crossover).cacheWriteTokens - requiredUsage(warm).cacheWriteTokens;
  return {
    sameEffortWarmHit: requiredUsage(warm).cacheReadTokens > 0,
    crossoverRead: requiredUsage(crossover).cacheReadTokens > 0,
    crossoverWrite: requiredUsage(crossover).cacheWriteTokens > 0,
    coldCostMicros: effectiveCostMicros(cold.usage, pricing),
    warmCostMicros: effectiveCostMicros(warm.usage, pricing),
    crossoverCostMicros: effectiveCostMicros(crossover.usage, pricing),
    reducedGenerationCostMicros,
    addedCacheWriteCostMicros: addedCacheWriteCostMicros * pricing.cacheWriteMicrosPerToken,
    generationSavingsExceedAddedWrite: reducedGenerationCostMicros > addedCacheWriteCostMicros * pricing.cacheWriteMicrosPerToken,
  };
}

export function cacheControlsFingerprint(value: CacheExperimentControls): Sha256 {
  const digest = canonicalProfileDigest(value);
  if (!digest.ok) throw new Error("cache controls are not canonical");
  return digest.digest;
}

/** Strict structural validation shared by successor evidence and immutable v3 parsing. */
export function validateCacheCrossover(groups: readonly CacheCrossoverGroup[]): void {
  if (!Array.isArray(groups) || groups.length !== 3) throw new Error("cache crossover requires exactly groups A, B, and C");
  const seen = new Set<string>();
  let successorFingerprint: string | undefined;
  for (const group of groups) {
    if (!["A", "B", "C"].includes(group.id) || seen.has(group.id)) throw new Error("invalid or duplicate cache crossover group");
    seen.add(group.id);
    exactKeys(group, ["id", "controls", "samples"], "cache group");
    const successor = isSuccessorControls(group.controls);
    const legacy = !successor && isLegacyControls(group.controls);
    if (!successor && !legacy) throw new Error("cache controls are empty, partial, or unknown");
    const fingerprint = cacheControlsFingerprint(group.controls);
    if (successor) {
      if (successorFingerprint !== undefined && successorFingerprint !== fingerprint) throw new Error("cache groups do not share one exact profile/environment");
      successorFingerprint = fingerprint;
    }
    if (!Array.isArray(group.samples) || group.samples.length !== 3) throw new Error("cache group requires cold, warm, and crossover samples");
    const [cold, warm, crossover] = group.samples;
    if (cold.phase !== "cold" || warm.phase !== "warm" || crossover.phase !== "crossover") throw new Error("invalid cache crossover phases");
    for (const [index, item] of group.samples.entries()) {
      if (item.id !== `${group.id}${index + 1}`) throw new Error("invalid cache sample identity");
      validateUsage(item.usage);
      if (!Number.isFinite(item.latencyMs) || item.latencyMs < 0) throw new Error("invalid cache sample latency");
      if (successor) validateSuccessorSample(item, fingerprint);
      else validateLegacySample(item, fingerprint);
    }
    if (successor) {
      if (!cold.rung || !warm.rung || !crossover.rung || !sameRung(cold.rung, warm.rung) || sameRung(warm.rung, crossover.rung)) throw new Error("cache crossover must use a same-rung control then a different-rung crossover");
    }
    if (successor && group.samples.every((item: CacheCrossoverSample) => usageKeys.every((key) => requiredUsage(item)[key] === 0))) throw new Error("all-zero cache evidence cannot qualify");
  }
  if (seen.size !== 3) throw new Error("cache crossover requires groups A, B, and C");
}

/** Recomputes canonical cache evidence; caller verdicts and counters are ignored. */
export function deriveCacheQualification(groups: readonly CacheCrossoverGroup[]): DerivedCacheQualification {
  validateCacheCrossover(groups);
  const groupsDigestResult = canonicalProfileDigest(groups);
  if (!groupsDigestResult.ok) throw new Error("cache groups are not canonical");
  const first = groups[0]!;
  if (!isSuccessorControls(first.controls) || groups.some((group) => !isSuccessorControls(group.controls))) {
    return Object.freeze({ groupsDigest: groupsDigestResult.digest, rawFieldObservability: "unavailable", verdict: "OBSERVABILITY_UNAVAILABLE" });
  }
  const bound = bindingFromControls(first.controls);
  const profileBindingDigest = canonicalDigest({ capability: bound.capability, admission: bound.admission });
  const environmentDigest = canonicalDigest(bound.match);
  const observations = groups.map((group) => ({ control: group.samples[1]!.rawCacheRead, crossover: group.samples[2]!.rawCacheRead }));
  if (observations.some(({ control, crossover }) => control?.status !== "present" || crossover?.status !== "present")) {
    return Object.freeze({
      groupsDigest: groupsDigestResult.digest,
      profileBindingDigest,
      environmentDigest,
      protocolDigest: first.controls.protocolDigest,
      authorizationDigest: first.controls.authorizationDigest,
      rawFieldObservability: "unavailable",
      verdict: "OBSERVABILITY_UNAVAILABLE",
      binding: bound,
    });
  }
  const positiveControlCachedTokens = observations.reduce((total, item) => total + (item.control?.status === "present" ? item.control.value : 0), 0);
  const crossoverCachedTokens = observations.reduce((total, item) => total + (item.crossover?.status === "present" ? item.crossover.value : 0), 0);
  const verdict: CacheCrossoverVerdict = observations.some((item) => item.control?.status === "present" && item.control.value === 0)
    ? "ENVIRONMENT_UNQUALIFIED"
    : observations.some((item) => item.crossover?.status === "present" && item.crossover.value === 0) ? "REGRESSION" : "PASS";
  return Object.freeze({
    groupsDigest: groupsDigestResult.digest,
    profileBindingDigest,
    environmentDigest,
    protocolDigest: first.controls.protocolDigest,
    authorizationDigest: first.controls.authorizationDigest,
    rawFieldObservability: "observed",
    positiveControlCachedTokens,
    crossoverCachedTokens,
    verdict,
    binding: bound,
  });
}

function isSuccessorControls(value: CacheExperimentControls): value is Required<Pick<CacheExperimentControls, (typeof successorControlKeys)[number]>> {
  if (!isRecord(value)) return false;
  try { exactKeys(value, successorControlKeys, "successor cache controls"); } catch { return false; }
  for (const key of successorControlKeys) {
    const item = value[key];
    if (key === "ttlSeconds") {
      if (!Number.isSafeInteger(item) || (item as number) <= 0) return false;
    } else if (typeof item !== "string" || item.length === 0) return false;
  }
  return isHash(value.capabilityProfileDigest) && isHash(value.admissionProfileDigest)
    && isHash(value.modelCatalogDigest) && isHash(value.providerAdapterDigest)
    && isHash(value.protocolDigest) && isHash(value.authorizationDigest);
}
function isLegacyControls(value: CacheExperimentControls): boolean {
  if (!isRecord(value)) return false;
  try { exactKeys(value, legacyControlKeys, "legacy cache controls"); } catch { return false; }
  return legacyControlKeys.every((key) => isHash(value[key]));
}
function validateSuccessorSample(value: CacheCrossoverSample, _fingerprint: string): void {
  exactKeys(value, ["id", "rung", "phase", "usage", "latencyMs"], "successor cache sample", ["rawCacheRead"]);
  if (!value.rung || !nonEmpty(value.rung.rungId) || !Number.isSafeInteger(value.rung.ordinal) || value.rung.ordinal < 0 || !nonEmpty(value.rung.providerValue)) throw new Error("invalid successor cache rung");
  if (value.rawCacheRead !== undefined) {
    if (!isRecord(value.rawCacheRead) || (value.rawCacheRead.status !== "present" && value.rawCacheRead.status !== "unobservable")) throw new Error("invalid raw cache observation");
    if (value.rawCacheRead.status === "present" && (!nonNegativeInteger(value.rawCacheRead.value) || value.rawCacheRead.value !== requiredUsage(value).cacheReadTokens)) throw new Error("raw cache observation does not match normalized usage");
  }
}
function validateLegacySample(value: CacheCrossoverSample, fingerprint: string): void {
  exactKeys(value, ["id", "effort", "phase", "controlsFingerprint", "providerRequests", "retries", "usage", "latencyMs"], "legacy cache sample", ["rung"]);
  if (!nonEmpty(value.effort) || value.controlsFingerprint !== fingerprint || value.providerRequests !== 1 || value.retries !== 0) throw new Error("invalid legacy cache sample");
  if (value.rung !== undefined && (!nonEmpty(value.rung.rungId) || !Number.isSafeInteger(value.rung.ordinal) || value.rung.ordinal < 0 || !nonEmpty(value.rung.providerValue))) throw new Error("invalid legacy cache rung");
}
function validateUsage(value: UsageMetrics): void {
  if (!isRecord(value)) throw new Error("cache usage must be an object");
  exactKeys(value, usageKeys, "cache usage");
  for (const key of usageKeys) if (!nonNegativeInteger(value[key])) throw new Error("cache usage must contain complete non-negative counters");
  if (value.inputTokens !== (value.uncachedInputTokens as number) + (value.cacheReadTokens as number)) throw new Error("cache input accounting is inconsistent");
}
function bindingFromControls(value: Required<Pick<CacheExperimentControls, (typeof successorControlKeys)[number]>>): Pick<ProfileBinding, "capability" | "admission" | "match"> {
  return Object.freeze({
    capability: Object.freeze({ profileId: value.capabilityProfileId, profileRevision: value.capabilityProfileRevision, profileDigest: value.capabilityProfileDigest }),
    admission: Object.freeze({ profileId: value.admissionProfileId, profileRevision: value.admissionProfileRevision, profileDigest: value.admissionProfileDigest }),
    match: Object.freeze({
      provider: value.provider,
      api: value.api,
      model: value.model,
      modelCatalogRevision: value.modelCatalogRevision,
      modelCatalogDigest: value.modelCatalogDigest,
      piVersion: value.piVersion,
      providerAdapterRevision: value.providerAdapterRevision,
      providerAdapterDigest: value.providerAdapterDigest,
    } satisfies ProfileMatch),
  });
}
function canonicalDigest(value: unknown): string {
  const result = canonicalProfileDigest(value);
  if (!result.ok) throw new Error("cache binding is not canonical");
  return result.digest;
}
function requiredUsage(value: CacheCrossoverSample): Required<Pick<UsageMetrics, (typeof usageKeys)[number]>> {
  return value.usage as Required<Pick<UsageMetrics, (typeof usageKeys)[number]>>;
}
function sameRung(left: NonNullable<CacheCrossoverSample["rung"]>, right: NonNullable<CacheCrossoverSample["rung"]>): boolean {
  return left.rungId === right.rungId && left.ordinal === right.ordinal && left.providerValue === right.providerValue;
}
function exactKeys(value: object, required: readonly string[], name: string, optional: readonly string[] = []): void {
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !required.includes(key) && !optional.includes(key)) || keys.some((key) => record[key] === undefined)) throw new Error(`${name} has unknown, missing, or undefined fields`);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isHash(value: unknown): value is Sha256 { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function nonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
