/**
 * Cache observations deliberately retain the distinction between a raw provider
 * field that was observed as zero and a Pi-normalized zero whose raw presence is
 * not observable.  The latter cannot establish a cache miss.
 */
export type RawCachedTokens =
  | { readonly status: "present"; readonly value: number }
  | { readonly status: "unavailable_at_pi_normalized_boundary" };

export interface LiveCacheReadObservation {
  readonly rawCachedTokens: RawCachedTokens;
  readonly piNormalizedCacheReadTokens: number;
  readonly liveEvalCacheReadTokens: number;
}

export type LiveCacheVerdict = "PASS" | "REGRESSION" | "ENVIRONMENT_UNQUALIFIED" | "OBSERVABILITY_UNAVAILABLE";

export interface LiveCacheComparison {
  readonly positiveControl: LiveCacheReadObservation;
  readonly crossover: LiveCacheReadObservation;
}

function nonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
}

/**
 * The synthetic seam is intentionally strict: when raw provider usage is
 * available, Pi normalization and the record consumed by live evaluation must
 * carry the same cache-read value.  Production Pi 0.82.1 does not expose this
 * raw field, so its adapter records the unavailable branch instead.
 */
export interface PiNormalizedAssistantUsage { readonly cacheRead: number }

/** Records the same terminal assistant-usage boundary consumed by live-production. */
export function recordPiAssistantUsage(usage: PiNormalizedAssistantUsage): LiveCacheReadObservation {
  const piNormalizedCacheReadTokens = usage.cacheRead;
  nonNegativeInteger(piNormalizedCacheReadTokens, "Pi normalized cache read");
  return Object.freeze({
    rawCachedTokens: Object.freeze({ status: "unavailable_at_pi_normalized_boundary" as const }),
    piNormalizedCacheReadTokens,
    liveEvalCacheReadTokens: piNormalizedCacheReadTokens,
  });
}

/** Only for a raw-field-capable adapter; production Pi 0.82.1 cannot call this path. */
export function recordObservedRawCacheRead(rawCachedTokens: number, piUsage: PiNormalizedAssistantUsage): LiveCacheReadObservation {
  nonNegativeInteger(rawCachedTokens, "raw cached_tokens");
  const piNormalizedCacheReadTokens = piUsage.cacheRead; nonNegativeInteger(piNormalizedCacheReadTokens, "Pi normalized cache read");
  if (rawCachedTokens !== piNormalizedCacheReadTokens) throw new Error("raw cached_tokens does not match Pi normalized cache read");
  return Object.freeze({
    rawCachedTokens: Object.freeze({ status: "present" as const, value: rawCachedTokens }),
    piNormalizedCacheReadTokens,
    liveEvalCacheReadTokens: piNormalizedCacheReadTokens,
  });
}

export function recordPiNormalizedCacheRead(piNormalizedCacheReadTokens: number): LiveCacheReadObservation {
  return recordPiAssistantUsage({ cacheRead: piNormalizedCacheReadTokens });
}

function validateObservation(observation: LiveCacheReadObservation): void {
  nonNegativeInteger(observation.piNormalizedCacheReadTokens, "Pi normalized cache read");
  nonNegativeInteger(observation.liveEvalCacheReadTokens, "live evaluation cache read");
  if (observation.piNormalizedCacheReadTokens !== observation.liveEvalCacheReadTokens) throw new Error("Pi normalized cache read does not match live evaluation record");
  if (observation.rawCachedTokens.status === "present") {
    nonNegativeInteger(observation.rawCachedTokens.value, "raw cached_tokens");
    if (observation.rawCachedTokens.value !== observation.piNormalizedCacheReadTokens) throw new Error("raw cached_tokens does not match Pi normalized cache read");
  } else if (observation.rawCachedTokens.status !== "unavailable_at_pi_normalized_boundary") {
    throw new Error("invalid raw cached_tokens observation");
  }
}

/** Classifies only qualified, same-environment/same-effort control comparisons. */
export function classifyLiveCacheComparison(comparisons: readonly LiveCacheComparison[]): LiveCacheVerdict {
  if (comparisons.length === 0) throw new Error("live cache comparison requires a positive-control/crossover pair");
  for (const comparison of comparisons) {
    validateObservation(comparison.positiveControl);
    validateObservation(comparison.crossover);
  }
  if (comparisons.some(({ positiveControl, crossover }) => positiveControl.rawCachedTokens.status !== "present" || crossover.rawCachedTokens.status !== "present")) {
    return "OBSERVABILITY_UNAVAILABLE";
  }
  const qualified = comparisons.filter(({ positiveControl }) => positiveControl.liveEvalCacheReadTokens > 0);
  if (qualified.length === 0) return "ENVIRONMENT_UNQUALIFIED";
  return qualified.every(({ crossover }) => crossover.liveEvalCacheReadTokens > 0) ? "PASS" : "REGRESSION";
}
