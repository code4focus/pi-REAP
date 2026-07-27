import type { UsageMetrics } from "./types.js";

/** Integer micro-currency rates keep synthetic and real calculations auditable. */
export interface TokenPricing { readonly uncachedInputMicrosPerToken: number; readonly outputMicrosPerToken: number; readonly reasoningMicrosPerToken: number; readonly cacheReadMicrosPerToken: number; readonly cacheWriteMicrosPerToken: number }
export const syntheticTokenPricing: TokenPricing = { uncachedInputMicrosPerToken: 10, outputMicrosPerToken: 30, reasoningMicrosPerToken: 20, cacheReadMicrosPerToken: 2, cacheWriteMicrosPerToken: 12 };

export function effectiveCostMicros(usage: UsageMetrics, pricing: TokenPricing): number {
  return (usage.uncachedInputTokens ?? 0) * pricing.uncachedInputMicrosPerToken
    + (usage.outputTokens ?? 0) * pricing.outputMicrosPerToken
    + (usage.reasoningTokens ?? 0) * pricing.reasoningMicrosPerToken
    + (usage.cacheReadTokens ?? 0) * pricing.cacheReadMicrosPerToken
    + (usage.cacheWriteTokens ?? 0) * pricing.cacheWriteMicrosPerToken;
}

/** Raw run evidence is costable only when all independently priced fields are present. */
export function observedEffectiveCostMicros(usage: UsageMetrics, pricing: TokenPricing): number | undefined {
  if (usage.uncachedInputTokens === undefined || usage.outputTokens === undefined || usage.reasoningTokens === undefined || usage.cacheReadTokens === undefined || usage.cacheWriteTokens === undefined) return undefined;
  return effectiveCostMicros(usage, pricing);
}

export function generationCostMicros(usage: UsageMetrics, pricing: TokenPricing): number {
  return (usage.outputTokens ?? 0) * pricing.outputMicrosPerToken + (usage.reasoningTokens ?? 0) * pricing.reasoningMicrosPerToken;
}
