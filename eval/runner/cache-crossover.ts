import { createHash } from "node:crypto";
import type { AutomaticEffort } from "../../src/domain/effort.js";
import { effectiveCostMicros, generationCostMicros, syntheticTokenPricing, type TokenPricing } from "./cost.js";
import type { UsageMetrics } from "./types.js";

export type Sha256 = string;
const controlKeys = ["modelHash", "providerHash", "systemPromptHash", "toolSetHash", "inputHash", "promptCacheKeyHash", "cacheModeHash", "transportHash", "historyHash"] as const;
const usageKeys = ["inputTokens", "uncachedInputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
export interface CacheExperimentControls {
  readonly modelHash: Sha256;
  readonly providerHash: Sha256;
  readonly systemPromptHash: Sha256;
  readonly toolSetHash: Sha256;
  readonly inputHash: Sha256;
  readonly promptCacheKeyHash: Sha256;
  readonly cacheModeHash: Sha256;
  readonly transportHash: Sha256;
  readonly historyHash: Sha256;
}
export interface CacheCrossoverSample { readonly id: string; readonly effort: AutomaticEffort; readonly phase: "cold" | "warm" | "crossover"; readonly controlsFingerprint: Sha256; readonly providerRequests: number; readonly retries: number; readonly usage: UsageMetrics; readonly latencyMs: number }
export interface CacheCrossoverGroup { readonly id: "A" | "B" | "C"; readonly controls: CacheExperimentControls; readonly samples: readonly [CacheCrossoverSample, CacheCrossoverSample, CacheCrossoverSample] }

const digest = (value: string): Sha256 => createHash("sha256").update(value).digest("hex");
const controls: CacheExperimentControls = {
  modelHash: digest("synthetic-model"), providerHash: digest("synthetic-provider"), systemPromptHash: digest("synthetic-system"), toolSetHash: digest("synthetic-tools"), inputHash: digest("synthetic-input"), promptCacheKeyHash: digest("synthetic-cache-key"), cacheModeHash: digest("synthetic-cache-mode"), transportHash: digest("synthetic-transport"), historyHash: digest("synthetic-history"),
};
const usage = (uncachedInputTokens: number, outputTokens: number, reasoningTokens: number, cacheReadTokens: number, cacheWriteTokens: number): UsageMetrics => ({ inputTokens: uncachedInputTokens + cacheReadTokens, uncachedInputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens });

/** SHA-256 of canonical JSON, never a delimiter-joined control string. */
export function cacheControlsFingerprint(value: CacheExperimentControls): Sha256 {
  validateControls(value);
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
const sample = (id: string, effort: AutomaticEffort, phase: CacheCrossoverSample["phase"], values: UsageMetrics, latencyMs: number): CacheCrossoverSample => ({ id, effort, phase, controlsFingerprint: cacheControlsFingerprint(controls), providerRequests: 1, retries: 0, usage: values, latencyMs });
/** Measurement-shaped, source-safe synthetic benchmark fixtures. Controls are fixed inside each A/B/C group. */
export const syntheticCacheCrossover: readonly CacheCrossoverGroup[] = [
  { id: "A", controls, samples: [sample("A1", "high", "cold", usage(120, 20, 40, 0, 120), 100), sample("A2", "high", "warm", usage(0, 18, 35, 120, 0), 70), sample("A3", "low", "crossover", usage(0, 10, 10, 120, 0), 45)] },
  { id: "B", controls, samples: [sample("B1", "low", "cold", usage(120, 10, 10, 0, 120), 60), sample("B2", "low", "warm", usage(0, 9, 9, 120, 0), 40), sample("B3", "high", "crossover", usage(120, 18, 35, 0, 120), 95)] },
  { id: "C", controls, samples: [sample("C1", "xhigh", "cold", usage(120, 28, 60, 0, 120), 150), sample("C2", "xhigh", "warm", usage(0, 26, 55, 120, 0), 110), sample("C3", "medium", "crossover", usage(0, 14, 20, 120, 0), 65)] },
];
export interface CrossoverAssessment { readonly sameEffortWarmHit: boolean; readonly crossoverRead: boolean; readonly crossoverWrite: boolean; readonly coldCostMicros: number; readonly warmCostMicros: number; readonly crossoverCostMicros: number; readonly reducedGenerationCostMicros: number; readonly addedCacheWriteCostMicros: number; readonly generationSavingsExceedAddedWrite: boolean }
export function assessCrossover(group: CacheCrossoverGroup, pricing: TokenPricing = syntheticTokenPricing): CrossoverAssessment {
  const [cold, warm, crossover] = group.samples;
  const coldGeneration = generationCostMicros(cold.usage, pricing); const crossoverGeneration = generationCostMicros(crossover.usage, pricing);
  const reducedGenerationCostMicros = coldGeneration - crossoverGeneration;
  const addedCacheWriteCostMicros = (crossover.usage.cacheWriteTokens - warm.usage.cacheWriteTokens) * pricing.cacheWriteMicrosPerToken;
  return { sameEffortWarmHit: warm.usage.cacheReadTokens > 0, crossoverRead: crossover.usage.cacheReadTokens > 0, crossoverWrite: crossover.usage.cacheWriteTokens > 0, coldCostMicros: effectiveCostMicros(cold.usage, pricing), warmCostMicros: effectiveCostMicros(warm.usage, pricing), crossoverCostMicros: effectiveCostMicros(crossover.usage, pricing), reducedGenerationCostMicros, addedCacheWriteCostMicros, generationSavingsExceedAddedWrite: reducedGenerationCostMicros > addedCacheWriteCostMicros };
}

/** Rejects anything other than the frozen A/B/C cache-crossover experiment and one shared validated control set. */
export function validateCacheCrossover(groups: unknown): asserts groups is readonly CacheCrossoverGroup[] {
  const matrix = { A: [["A1", "high", "cold"], ["A2", "high", "warm"], ["A3", "low", "crossover"]], B: [["B1", "low", "cold"], ["B2", "low", "warm"], ["B3", "high", "crossover"]], C: [["C1", "xhigh", "cold"], ["C2", "xhigh", "warm"], ["C3", "medium", "crossover"]] } as const;
  if (!Array.isArray(groups) || groups.length !== 3) throw new Error("cache crossover requires exactly groups A, B, and C");
  const seen = new Set<string>();
  for (const unknownGroup of groups) {
    if (!isRecord(unknownGroup)) throw new Error("cache crossover group must be an object");
    exactKeys(unknownGroup, ["id", "controls", "samples"], "cache crossover group");
    const group = unknownGroup as unknown as CacheCrossoverGroup;
    if (seen.has(group.id)) throw new Error(`duplicate cache crossover group ${group.id}`); seen.add(group.id);
    const expected = matrix[group.id]; if (!expected) throw new Error("unknown cache crossover group");
    if (!isRecord(group.controls)) throw new Error("cache crossover controls must be an object");
    validateControls(group.controls as CacheExperimentControls);
    const fingerprint = cacheControlsFingerprint(group.controls);
    if (!Array.isArray(group.samples) || group.samples.length !== 3) throw new Error(`cache crossover group ${group.id} must have exactly three samples`);
    for (const [index, unknownSample] of group.samples.entries()) {
      if (!isRecord(unknownSample)) throw new Error("cache crossover sample must be an object");
      exactKeys(unknownSample, ["id", "effort", "phase", "controlsFingerprint", "providerRequests", "retries", "usage", "latencyMs"], "cache crossover sample");
      const sample = unknownSample as unknown as CacheCrossoverSample; const [id, effort, phase] = expected[index]!;
      if (sample.id !== id || sample.effort !== effort || sample.phase !== phase) throw new Error(`cache crossover group ${group.id} has an invalid matrix row`);
      if (!isHash(sample.controlsFingerprint) || sample.controlsFingerprint !== fingerprint) throw new Error(`cache crossover group ${group.id} sample ${sample.id} has mismatched controls`);
      if (sample.providerRequests !== 1 || sample.retries !== 0) throw new Error(`cache crossover group ${group.id} sample ${sample.id} must have one request and zero retries`);
      if (!isRecord(sample.usage)) throw new Error("cache crossover sample usage must be an object"); exactKeys(sample.usage, usageKeys, "cache crossover usage"); validateUsage(sample.usage as UsageMetrics, group.id, sample.id);
      if (!Number.isFinite(sample.latencyMs) || sample.latencyMs < 0) throw new Error(`cache crossover group ${group.id} sample ${sample.id} has invalid latency`);
    }
    // A structurally valid crossover does not itself prove a provider cache hit.
    // Live verdicting owns that distinction because only its raw-field protocol
    // can tell a proven zero from Pi-normalized field absence.
  }
  if (seen.size !== 3 || !["A", "B", "C"].every((id) => seen.has(id))) throw new Error("cache crossover requires groups A, B, and C exactly once");
}

function validateControls(controls: CacheExperimentControls): void { exactKeys(controls as unknown as Record<string, unknown>, controlKeys, "cache crossover controls"); for (const key of controlKeys) if (!isHash(controls[key])) throw new Error("cache crossover controls must contain only SHA-256 references"); }
function validateUsage(usage: UsageMetrics, group: string, sample: string): void { for (const key of usageKeys) if (!Number.isInteger(usage[key]) || usage[key] < 0) throw new Error(`cache crossover group ${group} sample ${sample} has invalid ${key}`); if (usage.inputTokens !== usage.uncachedInputTokens + usage.cacheReadTokens) throw new Error(`cache crossover group ${group} sample ${sample} has inconsistent input token accounting`); }
function isHash(value: unknown): value is Sha256 { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void { if (Object.keys(value).length !== expected.length || Object.keys(value).some((key) => !expected.includes(key)) || Object.values(value).some((item) => item === undefined)) throw new Error(`${name} has unknown, missing, or undefined keys`); }
function canonicalJson(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`; }
