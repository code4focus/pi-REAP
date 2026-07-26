import type { UsageMetrics } from "./types.js";

/** Integer micro-currency rates keep synthetic and real calculations auditable. */
export interface TokenPricing { readonly uncachedInputMicrosPerToken: number; readonly outputMicrosPerToken: number; readonly reasoningMicrosPerToken: number; readonly cacheReadMicrosPerToken: number; readonly cacheWriteMicrosPerToken: number }
export const syntheticTokenPricing: TokenPricing = { uncachedInputMicrosPerToken: 10, outputMicrosPerToken: 30, reasoningMicrosPerToken: 20, cacheReadMicrosPerToken: 2, cacheWriteMicrosPerToken: 12 };

export function effectiveCostMicros(usage: UsageMetrics, pricing: TokenPricing): number {
  return usage.uncachedInputTokens * pricing.uncachedInputMicrosPerToken
    + usage.outputTokens * pricing.outputMicrosPerToken
    + usage.reasoningTokens * pricing.reasoningMicrosPerToken
    + usage.cacheReadTokens * pricing.cacheReadMicrosPerToken
    + usage.cacheWriteTokens * pricing.cacheWriteMicrosPerToken;
}

export function generationCostMicros(usage: UsageMetrics, pricing: TokenPricing): number {
  return usage.outputTokens * pricing.outputMicrosPerToken + usage.reasoningTokens * pricing.reasoningMicrosPerToken;
}
