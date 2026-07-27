import { createHash } from "node:crypto";
import type { Effort } from "../domain/effort.js";

export const supportedProviderApis = ["openai-codex-responses", "openai-responses"] as const;
export type SupportedProviderApi = (typeof supportedProviderApis)[number];
export interface ProviderModel { api?: unknown; reasoning?: unknown; thinkingLevelMap?: unknown; }
export type ProviderPatchStatus = "applied" | "unsupported" | "invalid_payload" | "mapping_failed";
export type ProviderPatchOutcome =
  | { payload: unknown; status: "applied"; originalEffort?: string; appliedEffort: string }
  | { payload: unknown; status: "unsupported" | "invalid_payload" | "mapping_failed"; originalEffort?: string; appliedEffort?: never };
export interface EffortMutationConflict { code: "later_effort_mutator"; expectedEffort: string; observedEffort: string; message: string; }
type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const isSupportedApi = (api: unknown): api is SupportedProviderApi => typeof api === "string" && (supportedProviderApis as readonly string[]).includes(api);
/** True only for the two Pi/OpenAI Responses paths that expose reasoning effort. */
export function supportsEffortRouting(model: ProviderModel | undefined): boolean { return model?.reasoning === true && isSupportedApi(model.api); }
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
  for (const level of automaticLevels.slice(start + 1)) { const higher = mappings[level]; if (typeof higher === "string" && higher.length > 0) return higher; if (higher !== undefined && higher !== null) return undefined; }
  return undefined;
}
export function patchReasoningEffort(payload: unknown, effort: string): unknown {
  if (!isRecord(payload) || typeof effort !== "string" || effort.length === 0) return payload;
  if (!("reasoning" in payload)) return { ...payload, reasoning: { effort } };
  const reasoning = payload.reasoning;
  if (!isRecord(reasoning) || ("effort" in reasoning && typeof reasoning.effort !== "string")) return payload;
  return { ...payload, reasoning: { ...reasoning, effort } };
}
export function patchProviderPayload(model: ProviderModel | undefined, payload: unknown, desired: Effort): unknown { const effort = resolveProviderEffort(model, desired); return effort === undefined ? payload : patchReasoningEffort(payload, effort); }
/** A truthful patch result: failure outcomes retain the identical payload object. */
export function patchProviderPayloadOutcome(model: ProviderModel | undefined, payload: unknown, desired: Effort): ProviderPatchOutcome {
  const originalEffort = effortIn(payload);
  if (!supportsEffortRouting(model)) return { payload, status: "unsupported", ...(originalEffort ? { originalEffort } : {}) };
  const mapped = resolveProviderEffort(model, desired);
  if (mapped === undefined) return { payload, status: "mapping_failed", ...(originalEffort ? { originalEffort } : {}) };
  const patched = patchReasoningEffort(payload, mapped);
  if (patched === payload) return { payload, status: "invalid_payload", ...(originalEffort ? { originalEffort } : {}) };
  return { payload: patched, status: "applied", ...(originalEffort ? { originalEffort } : {}), appliedEffort: mapped };
}
/** Local diagnostic only; Pi does not expose final provider-wire observation here. */
export function diagnoseLaterEffortMutator(expectedEffort: string | undefined, observedEffort: string | undefined): EffortMutationConflict | undefined {
  if (expectedEffort === undefined || observedEffort === undefined || expectedEffort === observedEffort) return undefined;
  return { code: "later_effort_mutator", expectedEffort, observedEffort, message: `Local observation: reasoning.effort ${JSON.stringify(observedEffort)} after Pi REAP requested ${JSON.stringify(expectedEffort)}. This is not provider wire truth. Another later before_provider_request mutator may own the final value; remove it or place Pi REAP last, then verify with a final-payload logger.` };
}
export function withoutReasoningEffort(payload: unknown): unknown { if (!isRecord(payload) || !isRecord(payload.reasoning) || !("effort" in payload.reasoning)) return payload; const { effort: _effort, ...reasoning } = payload.reasoning; return { ...payload, reasoning }; }
function effortIn(payload: unknown): string | undefined { return isRecord(payload) && isRecord(payload.reasoning) && typeof payload.reasoning.effort === "string" ? payload.reasoning.effort : undefined; }
function canonicalize(value: unknown): string { if (value === null) return "null"; switch (typeof value) { case "string": return JSON.stringify(value); case "boolean": return value ? "true" : "false"; case "number": return Number.isFinite(value) ? String(value) : JSON.stringify(String(value)); case "undefined": return '"__undefined__"'; case "object": if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")} ]`; if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`; return JSON.stringify(String(value)); default: return JSON.stringify(String(value)); } }
export function canonicalPayloadHash(payload: unknown): string { return createHash("sha256").update(canonicalize(payload)).digest("hex"); }
