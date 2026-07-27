import {
  canonicalJson,
  canonicalProfileDigest,
  isTrustedBoundProviderSelection,
  resolveProfile,
  type DigestResult,
  type ProfileBinding,
  type ResolvedRung,
} from "../domain/profile.js";

export const supportedProviderApis = ["openai-codex-responses", "openai-responses"] as const;
export type SupportedProviderApi = (typeof supportedProviderApis)[number];

type RecordValue = Record<string, unknown>;

/** The complete, profile-bound input produced before a provider request. */
export interface ProviderPatchInput {
  /** Preferred PR3 contract: factory-issued immutable exact provider selection. */
  readonly boundSelection?: unknown;
  /** Legacy direct PR2 contract; retained for isolated adapter contract coverage. */
  readonly identity?: unknown;
  readonly capabilityProfile?: unknown;
  readonly admissionProfile?: unknown;
  readonly resolvedRung?: unknown;
}

export type ProviderPatchOutcome =
  | { readonly status: "applied"; readonly payload: unknown; readonly originalEffort?: string; readonly appliedEffort: string }
  | { readonly status: "unsupported" | "invalid_payload" | "mapping_failed"; readonly payload: unknown; readonly originalEffort?: string };

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** True only for the two v1 Responses APIs; profile admission remains authoritative. */
export const supportsEffortRouting = (api: unknown): api is SupportedProviderApi =>
  typeof api === "string" && (supportedProviderApis as readonly string[]).includes(api);

const sameBinding = (left: ProfileBinding, right: ProfileBinding): boolean =>
  left.capability.profileId === right.capability.profileId
  && left.capability.profileRevision === right.capability.profileRevision
  && left.capability.profileDigest === right.capability.profileDigest
  && left.admission.profileId === right.admission.profileId
  && left.admission.profileRevision === right.admission.profileRevision
  && left.admission.profileDigest === right.admission.profileDigest
  && left.match.provider === right.match.provider
  && left.match.api === right.match.api
  && left.match.model === right.match.model
  && left.match.modelCatalogRevision === right.match.modelCatalogRevision
  && left.match.modelCatalogDigest === right.match.modelCatalogDigest
  && left.match.piVersion === right.match.piVersion
  && left.match.providerAdapterRevision === right.match.providerAdapterRevision
  && left.match.providerAdapterDigest === right.match.providerAdapterDigest;

function resolvedProviderEffort(input: ProviderPatchInput): string | undefined {
  try {
    if (Object.hasOwn(input, "boundSelection")) {
      return isTrustedBoundProviderSelection(input.boundSelection) && supportsEffortRouting(input.boundSelection.api)
        ? input.boundSelection.effort
        : undefined;
    }
    const resolution = resolveProfile(input.identity, input.capabilityProfile, input.admissionProfile);
    if (resolution.status !== "resolved" || !supportsEffortRouting(resolution.binding.match.api)) return undefined;

    const candidate = input.resolvedRung as Partial<ResolvedRung> | null;
    if (!candidate || typeof candidate !== "object" || !sameBinding(candidate.binding as ProfileBinding, resolution.binding)) {
      return undefined;
    }
    if (typeof candidate.rungId !== "string" || !Number.isSafeInteger(candidate.ordinal)) return undefined;
    const rung = resolution.capability.rungs.find((value) =>
      value.id === candidate.rungId && value.ordinal === candidate.ordinal,
    );
    // V1 Responses encodes effort as a non-empty provider-owned string only.
    return rung && typeof rung.providerValue === "string" && rung.providerValue.length > 0
      ? rung.providerValue
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Changes only reasoning.effort for an exact, resolved profile-local rung.
 * Every unsupported or malformed boundary returns the original object by reference.
 */
export function patchProviderPayload(input: ProviderPatchInput, payload: unknown): unknown {
  const effort = resolvedProviderEffort(input);
  if (effort === undefined || !isRecord(payload) || !canonicalJson(payload).ok) return payload;
  try {
    if (!Object.hasOwn(payload, "reasoning")) return { ...payload, reasoning: { effort } };
    const reasoning = payload.reasoning;
    if (!isRecord(reasoning) || (Object.hasOwn(reasoning, "effort") && typeof reasoning.effort !== "string")) {
      return payload;
    }
    return { ...payload, reasoning: { ...reasoning, effort } };
  } catch {
    return payload;
  }
}

/** Observability-only result. It never invents a provider value or changes patch semantics. */
export function patchProviderPayloadOutcome(input: ProviderPatchInput | undefined, payload: unknown): ProviderPatchOutcome {
  const originalEffort = effortIn(payload);
  if (!input || !Object.hasOwn(input, "boundSelection") || !isTrustedBoundProviderSelection(input.boundSelection)
    || !supportsEffortRouting(input.boundSelection.api)) {
    return { status: "unsupported", payload, ...(originalEffort === undefined ? {} : { originalEffort }) };
  }
  const patched = patchProviderPayload(input, payload);
  if (patched === payload) {
    return { status: canonicalJson(payload).ok ? "mapping_failed" : "invalid_payload", payload, ...(originalEffort === undefined ? {} : { originalEffort }) };
  }
  return { status: "applied", payload: patched, ...(originalEffort === undefined ? {} : { originalEffort }), appliedEffort: input.boundSelection.effort };
}

function effortIn(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.reasoning)) return undefined;
  return typeof payload.reasoning.effort === "string" ? payload.reasoning.effort : undefined;
}

/** Removes only the mutable field for structural preservation assertions. */
export function withoutReasoningEffort(payload: unknown): unknown {
  if (!isRecord(payload) || !canonicalJson(payload).ok || !isRecord(payload.reasoning) || !Object.hasOwn(payload.reasoning, "effort")) {
    return payload;
  }
  const { effort: _effort, ...reasoning } = payload.reasoning;
  return { ...payload, reasoning };
}

/** Stable digest for closed sanitized JSON-like payloads, with typed failure. */
export function canonicalPayloadHash(payload: unknown): DigestResult {
  return canonicalProfileDigest(payload);
}
