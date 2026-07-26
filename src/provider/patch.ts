import { createHash } from "node:crypto";
import type { Effort } from "../domain/effort.js";

export const supportedProviderApis = ["openai-codex-responses", "openai-responses"] as const;
export type SupportedProviderApi = (typeof supportedProviderApis)[number];

export interface ProviderModel {
  api?: unknown;
  reasoning?: unknown;
  thinkingLevelMap?: unknown;
}

type RecordValue = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSupportedApi = (api: unknown): api is SupportedProviderApi =>
  typeof api === "string" && (supportedProviderApis as readonly string[]).includes(api);

/** True only for the two Pi/OpenAI Responses paths that expose reasoning effort. */
export function supportsEffortRouting(model: ProviderModel | undefined): boolean {
  return model?.reasoning === true && isSupportedApi(model.api);
}

/**
 * Resolves a provider-specific spelling without selecting an effort level.
 * An invalid or explicitly unsupported mapping leaves the caller at baseline.
 */
export function resolveProviderEffort(model: ProviderModel | undefined, desired: Effort): string | undefined {
  if (model === undefined || !supportsEffortRouting(model)) return undefined;
  const mappings = model.thinkingLevelMap;
  if (mappings === undefined) return desired;
  if (!isRecord(mappings)) return undefined;
  const mapped = mappings[desired];
  if (mapped === undefined) return desired;
  if (typeof mapped === "string" && mapped.length > 0) return mapped;
  if (mapped !== null || desired === "max") return undefined;

  const automaticLevels: readonly Effort[] = ["low", "medium", "high", "xhigh"];
  const start = automaticLevels.indexOf(desired);
  for (const level of automaticLevels.slice(start + 1)) {
    const higher = mappings[level];
    if (typeof higher === "string" && higher.length > 0) return higher;
    if (higher !== undefined && higher !== null) return undefined;
  }
  return undefined;
}

/**
 * Creates a reasoning object containing only the requested effort when absent.
 * Malformed or conflicted reasoning remains unchanged; otherwise only the path
 * to effort is cloned.
 */
export function patchReasoningEffort(payload: unknown, effort: string): unknown {
  if (!isRecord(payload) || typeof effort !== "string" || effort.length === 0) return payload;

  if (!("reasoning" in payload)) return { ...payload, reasoning: { effort } };
  const reasoning = payload.reasoning;
  if (!isRecord(reasoning)) return payload;
  if ("effort" in reasoning && typeof reasoning.effort !== "string") return payload;
  return { ...payload, reasoning: { ...reasoning, effort } };
}

/** Applies a pre-decided target locally, or returns the unmodified request. */
export function patchProviderPayload(
  model: ProviderModel | undefined,
  payload: unknown,
  desired: Effort,
): unknown {
  const effort = resolveProviderEffort(model, desired);
  return effort === undefined ? payload : patchReasoningEffort(payload, effort);
}

/** Removes only the mutable field for structural preservation assertions. */
export function withoutReasoningEffort(payload: unknown): unknown {
  if (!isRecord(payload) || !isRecord(payload.reasoning) || !("effort" in payload.reasoning)) return payload;
  const { effort: _effort, ...reasoning } = payload.reasoning;
  return { ...payload, reasoning };
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string": return JSON.stringify(value);
    case "boolean": return value ? "true" : "false";
    case "number": return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
    case "undefined": return '"__undefined__"';
    case "object":
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")} ]`;
      if (isRecord(value)) {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
      }
      return JSON.stringify(String(value));
    default: return JSON.stringify(String(value));
  }
}

/** Stable SHA-256 fingerprint for sanitized JSON-like request payloads. */
export function canonicalPayloadHash(payload: unknown): string {
  return createHash("sha256").update(canonicalize(payload)).digest("hex");
}
