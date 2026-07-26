import type { AutomaticEffort } from "../../src/domain/effort.js";
import { effectiveCostMicros, generationCostMicros, syntheticTokenPricing, type TokenPricing } from "./cost.js";
import type { UsageMetrics } from "./types.js";

export interface CacheExperimentControls { readonly model: string; readonly provider: string; readonly systemPromptFingerprint: string; readonly toolSetFingerprint: string; readonly inputFingerprint: string; readonly promptCacheKeyFingerprint: string; readonly cacheMode: string; readonly ttlSeconds: number; readonly transport: string; readonly historyFingerprint: string }
export interface CacheCrossoverSample { readonly id: string; readonly effort: AutomaticEffort; readonly phase: "cold" | "warm" | "crossover"; readonly usage: UsageMetrics; readonly latencyMs: number }
export interface CacheCrossoverGroup { readonly id: "A" | "B" | "C"; readonly controls: CacheExperimentControls; readonly samples: readonly [CacheCrossoverSample, CacheCrossoverSample, CacheCrossoverSample] }
const controls: CacheExperimentControls = { model: "synthetic-model", provider: "synthetic-provider", systemPromptFingerprint: "synthetic-system-v1", toolSetFingerprint: "synthetic-tools-v1", inputFingerprint: "synthetic-input-v1", promptCacheKeyFingerprint: "synthetic-cache-key-v1", cacheMode: "explicit", ttlSeconds: 300, transport: "synthetic", historyFingerprint: "synthetic-history-v1" };
const usage = (uncachedInputTokens: number, outputTokens: number, reasoningTokens: number, cacheReadTokens: number, cacheWriteTokens: number): UsageMetrics => ({ inputTokens: uncachedInputTokens + cacheReadTokens, uncachedInputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens });
const sample = (id: string, effort: AutomaticEffort, phase: CacheCrossoverSample["phase"], values: UsageMetrics, latencyMs: number): CacheCrossoverSample => ({ id, effort, phase, usage: values, latencyMs });
/** Measurement-shaped, source-safe synthetic benchmark fixtures. All controls are fixed inside each group; only effort changes. */
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
