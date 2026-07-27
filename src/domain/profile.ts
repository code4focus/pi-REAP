import {
  canonicalJson,
  canonicalProfileDigest,
  type CanonicalData,
  type CanonicalFailureReason,
} from "./canonical-json.js";

export {
  canonicalJson,
  canonicalProfileDigest,
  type CanonicalData,
  type CanonicalFailureReason,
  type CanonicalResult,
  type DigestResult,
} from "./canonical-json.js";

export type RungId = string;
export type AdmissionAnchor = "economical" | "balanced" | "deliberate" | "exhaustive";

export type ProfileSource =
  | {
      readonly kind: "repository-pinned";
      readonly repositoryRevision: string;
    }
  | {
      readonly kind: "user-approved-local";
      readonly approvalDigest: string;
    }
  | {
      readonly kind: "validated-catalog-candidate";
      readonly authority: "candidate-only";
      readonly evidenceDigest: string;
    };

export interface ReasoningRung {
  readonly id: RungId;
  readonly ordinal: number;
  /** Opaque provider data constrained to the canonical data domain. */
  readonly providerValue: CanonicalData;
  readonly automaticEligible: boolean;
  readonly explicitOnly: boolean;
  readonly aliases?: readonly string[];
}

export interface ProfileMatch {
  readonly provider: string;
  readonly api: string;
  readonly model: string;
  readonly modelCatalogRevision: string;
  readonly modelCatalogDigest: string;
  readonly piVersion: string;
  readonly providerAdapterRevision: string;
  readonly providerAdapterDigest: string;
}

export interface ProfileIdentity {
  readonly profileId: string;
  readonly profileRevision: string;
  readonly profileDigest: string;
}

export interface ProfileBinding {
  readonly capability: ProfileIdentity;
  readonly admission: ProfileIdentity;
  readonly match: ProfileMatch;
}

export interface ReasoningCapabilityProfile {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly profileRevision: string;
  readonly source: ProfileSource;
  readonly match: ProfileMatch;
  readonly rungs: readonly ReasoningRung[];
  readonly automaticFloor: RungId;
  readonly automaticCeiling: RungId;
  readonly explicitCeiling?: RungId;
  readonly anchors: Readonly<Record<AdmissionAnchor, RungId>>;
  readonly baselineBehavior: "preserve-request" | "known-profile-default";
}

export type RungSelector =
  | { readonly kind: "lowest-automatic" }
  | { readonly kind: "next-above-lowest" }
  | { readonly kind: "next-below-ceiling" }
  | { readonly kind: "automatic-ceiling" }
  | { readonly kind: "anchor"; readonly name: AdmissionAnchor };

export interface EscalationRule {
  readonly selector: RungSelector;
}

export type InitialAdmissionKey =
  | "simpleQuery"
  | "boundedRead"
  | "implementation"
  | "debugging"
  | "architecture"
  | "highRisk"
  | "continuation"
  | "unknown";

export type EvidenceAdmissionKey =
  | "firstToolError"
  | "repeatedToolError"
  | "providerError"
  | "lengthExhaustion"
  | "overflowRetry"
  | "failedContinuation";

export interface AdmissionProfile {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly profileRevision: string;
  readonly source: ProfileSource;
  readonly capabilityProfileId: string;
  readonly capabilityProfileRevision: string;
  readonly initial: Readonly<Record<InitialAdmissionKey, RungSelector>>;
  readonly evidence: Readonly<Record<EvidenceAdmissionKey, EscalationRule>>;
}

export interface ResolvedRung {
  readonly binding: ProfileBinding;
  readonly rungId: RungId;
  readonly ordinal: number;
}

export interface ProfileRequestIdentity {
  readonly match: ProfileMatch;
  readonly profileBinding: ProfileBinding;
}

export type ProfileResolution =
  | {
      readonly status: "resolved";
      readonly capability: ReasoningCapabilityProfile;
      readonly admission: AdmissionProfile;
      readonly binding: ProfileBinding;
    }
  | { readonly status: "unknown-model" }
  | { readonly status: "profile-revision-mismatch" }
  | { readonly status: "unsupported-api" }
  | { readonly status: "invalid-provider-metadata" }
  | { readonly status: "invalid-profile-binding" }
  | { readonly status: "invalid-capability-profile" }
  | { readonly status: "invalid-admission-profile" }
  | { readonly status: "unapproved-profile-source" };

export type ProfileBindingResult =
  | { readonly ok: true; readonly binding: ProfileBinding }
  | { readonly ok: false; readonly reason: "invalid-capability-profile" | "invalid-admission-profile" | CanonicalFailureReason };

export interface CompiledProfileRouting {
  readonly initial: Readonly<Record<InitialAdmissionKey, ResolvedRung>>;
  readonly evidence: Readonly<Record<EvidenceAdmissionKey, ResolvedRung>>;
  /** Exact IDs and aliases that the session-local command may choose. */
  readonly manual: Readonly<Record<string, ResolvedRung>>;
  /** Factory-issued provider encodings for profile-local rungs. */
  readonly provider: Readonly<Record<string, BoundProviderSelection | undefined>>;
}

/** Exact factory-issued provider encoding; consumers must reject unissued lookalikes. */
export interface BoundProviderSelection {
  readonly binding: ProfileBinding;
  readonly api: ProfileMatch["api"];
  readonly rungId: RungId;
  readonly ordinal: number;
  readonly effort: string;
}

/** Detached, frozen activation material. Candidate profiles may be inspected but never activated. */
export type ProfileActivationSnapshot =
  | { readonly status: "ready"; readonly binding: ProfileBinding; readonly capability: ReasoningCapabilityProfile; readonly admission: AdmissionProfile; readonly routing: CompiledProfileRouting }
  | { readonly status: "candidate" }
  | { readonly status: "invalid" };

const issuedSnapshots = new WeakSet<object>();
const issuedProviderSelections = new WeakSet<object>();
let bindingDigestCount = 0;

/** Read-only diagnostic used by contract probes; routing must not advance it after activation preparation. */
export function profilePreparationProbe(): Readonly<{ bindingDigests: number }> {
  return Object.freeze({ bindingDigests: bindingDigestCount });
}

const ADMISSION_ANCHORS = ["economical", "balanced", "deliberate", "exhaustive"] as const;
const INITIAL_KEYS = [
  "simpleQuery",
  "boundedRead",
  "implementation",
  "debugging",
  "architecture",
  "highRisk",
  "continuation",
  "unknown",
] as const;
const EVIDENCE_KEYS = [
  "firstToolError",
  "repeatedToolError",
  "providerError",
  "lengthExhaustion",
  "overflowRetry",
  "failedContinuation",
] as const;
const MATCH_KEYS = [
  "provider",
  "api",
  "model",
  "modelCatalogRevision",
  "modelCatalogDigest",
  "piVersion",
  "providerAdapterRevision",
  "providerAdapterDigest",
] as const;
const PROFILE_IDENTITY_KEYS = ["profileId", "profileRevision", "profileDigest"] as const;
const SHA256 = /^[a-f0-9]{64}$/;
const RESERVED_COMMAND_TOKENS = new Set<string>([
  "status", "auto", "shadow", "enforce", "prototype", ...Object.getOwnPropertyNames(Object.prototype),
]);

/** True only for a profile-local identifier that cannot collide with command syntax or object built-ins. */
export function isCommandSafeToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/\s/u.test(value) && !RESERVED_COMMAND_TOKENS.has(value);
}

export function validateCapabilityProfile(value: unknown): value is ReasoningCapabilityProfile {
  return parseCapabilityProfile(value) !== undefined;
}

export function validateAdmissionProfile(
  value: unknown,
  capabilityValue: unknown,
): value is AdmissionProfile {
  const capability = parseCapabilityProfile(capabilityValue);
  return capability !== undefined && parseAdmissionProfile(value, capability) !== undefined;
}

/** Computes a binding over immutable validated snapshots of both profiles. */
export function createProfileBinding(
  capabilityValue: unknown,
  admissionValue: unknown,
): ProfileBindingResult {
  const capability = parseCapabilityProfile(capabilityValue);
  if (!capability) return { ok: false, reason: "invalid-capability-profile" };
  const admission = parseAdmissionProfile(admissionValue, capability);
  if (!admission) return { ok: false, reason: "invalid-admission-profile" };
  return bindingFromValidatedProfiles(capability, admission);
}

/**
 * Copies closed profile data before validating it, so later caller mutation and accessors cannot affect routing.
 * This is intentionally a one-time preparation boundary; request hooks compare only the frozen result.
 */
export function createProfileActivationSnapshot(
  capabilityValue: unknown,
  admissionValue: unknown,
): ProfileActivationSnapshot {
  try {
    const capabilityCopy = detachedCanonicalCopy(capabilityValue);
    const admissionCopy = detachedCanonicalCopy(admissionValue);
    if (capabilityCopy === undefined || admissionCopy === undefined) return issueSnapshot({ status: "invalid" });
    const binding = createProfileBinding(capabilityCopy, admissionCopy);
    if (!binding.ok) return issueSnapshot({ status: "invalid" });
    const resolution = resolveProfile(
      { match: binding.binding.match, profileBinding: binding.binding },
      capabilityCopy,
      admissionCopy,
    );
    if (resolution.status === "unapproved-profile-source") return issueSnapshot({ status: "candidate" });
    if (resolution.status !== "resolved") return issueSnapshot({ status: "invalid" });
    const bindingSnapshot = deepFreeze(resolution.binding);
    const capability = deepFreeze(resolution.capability);
    const admission = deepFreeze(resolution.admission);
    const routing = compileRouting(capability, admission, bindingSnapshot);
    if (!routing) return issueSnapshot({ status: "invalid" });
    return issueSnapshot({
      status: "ready",
      binding: bindingSnapshot,
      capability,
      admission,
      routing,
    });
  } catch {
    return issueSnapshot({ status: "invalid" });
  }
}

/** Rejects forged, mutated, or hostile objects at the runtime activation boundary. */
export function isTrustedProfileActivationSnapshot(value: unknown): value is ProfileActivationSnapshot {
  try { return typeof value === "object" && value !== null && issuedSnapshots.has(value) && Object.isFrozen(value); } catch { return false; }
}

/** Validates that a provider encoding came from a frozen profile activation snapshot. */
export function isTrustedBoundProviderSelection(value: unknown): value is BoundProviderSelection {
  try { return typeof value === "object" && value !== null && issuedProviderSelections.has(value) && Object.isFrozen(value); } catch { return false; }
}

/** Resolves exact runtime identity and both profile contents, failing closed. */
export function resolveProfile(
  identityValue: unknown,
  capabilityValue: unknown,
  admissionValue: unknown,
): ProfileResolution {
  const identityEnvelope = parseIdentityEnvelope(identityValue);
  if (!identityEnvelope) return { status: "invalid-provider-metadata" };
  const requestBinding = parseProfileBinding(identityEnvelope.profileBinding);
  if (!requestBinding) return { status: "invalid-profile-binding" };
  const capability = parseCapabilityProfile(capabilityValue);
  if (!capability) return { status: "invalid-capability-profile" };
  const admission = parseAdmissionProfile(admissionValue, capability);
  if (!admission) return { status: "invalid-admission-profile" };
  if (!hasAdmissionAuthority(capability.source) || !hasAdmissionAuthority(admission.source)) {
    return { status: "unapproved-profile-source" };
  }
  if (identityEnvelope.match.api !== capability.match.api) return { status: "unsupported-api" };
  if (!sameMatch(identityEnvelope.match, capability.match)) return { status: "unknown-model" };
  const expected = bindingFromValidatedProfiles(capability, admission);
  if (!expected.ok) {
    return {
      status: expected.reason === "invalid-capability-profile"
        ? "invalid-capability-profile"
        : "invalid-admission-profile",
    };
  }
  if (!sameBinding(requestBinding, expected.binding)) return { status: "profile-revision-mismatch" };
  return { status: "resolved", capability, admission, binding: expected.binding };
}

/** Resolves only admission-authorized automatic selectors; explicit-only rungs are unreachable. */
export function resolveAutomaticRung(
  capabilityValue: unknown,
  admissionValue: unknown,
  selectorValue: unknown,
): ResolvedRung | undefined {
  try {
    const capability = parseCapabilityProfile(capabilityValue);
    if (!capability) return undefined;
    const admission = parseAdmissionProfile(admissionValue, capability);
    if (!admission) return undefined;
    const selector = parseSelector(selectorValue);
    if (!selector || !selectorFeasible(selector, capability)) return undefined;
    const automatic = automaticRungs(capability);
    const selected = selectAutomatic(selector, capability, automatic);
    if (!selected || selected.explicitOnly || !selected.automaticEligible) return undefined;
    const binding = bindingFromValidatedProfiles(capability, admission);
    if (!binding.ok) return undefined;
    return { binding: binding.binding, rungId: selected.id, ordinal: selected.ordinal };
  } catch {
    return undefined;
  }
}

export const preservesBaseline = (resolution: ProfileResolution): boolean =>
  resolution.status !== "resolved";

function compileRouting(
  capability: ReasoningCapabilityProfile,
  admission: AdmissionProfile,
  binding: ProfileBinding,
): CompiledProfileRouting | undefined {
  try {
    const automatic = automaticRungs(capability);
    const resolve = (selector: RungSelector): ResolvedRung | undefined => {
      const rung = selectAutomatic(selector, capability, automatic);
      return rung && rung.automaticEligible && !rung.explicitOnly
        ? deepFreeze({ binding, rungId: rung.id, ordinal: rung.ordinal })
        : undefined;
    };
    const initial = Object.create(null) as Record<InitialAdmissionKey, ResolvedRung>;
    for (const key of INITIAL_KEYS) {
      const rung = resolve(admission.initial[key]);
      if (!rung) return undefined;
      initial[key] = rung;
    }
    const evidence = Object.create(null) as Record<EvidenceAdmissionKey, ResolvedRung>;
    for (const key of EVIDENCE_KEYS) {
      const rung = resolve(admission.evidence[key].selector);
      if (!rung) return undefined;
      evidence[key] = rung;
    }
    const ceilingId = capability.explicitCeiling ?? capability.automaticCeiling;
    const ceiling = capability.rungs.find((rung) => rung.id === ceilingId);
    if (!ceiling) return undefined;
    const manual = Object.create(null) as Record<string, ResolvedRung>;
    const provider = Object.create(null) as Record<string, BoundProviderSelection | undefined>;
    for (const rung of capability.rungs) {
      if (rung.ordinal > ceiling.ordinal) continue;
      if (!isCommandSafeToken(rung.id) || (rung.aliases ?? []).some((alias) => !isCommandSafeToken(alias))) return undefined;
      const resolved = deepFreeze({ binding, rungId: rung.id, ordinal: rung.ordinal });
      manual[rung.id] = resolved;
      for (const alias of rung.aliases ?? []) manual[alias] = resolved;
      provider[rung.id] = typeof rung.providerValue === "string" && rung.providerValue.length > 0
        ? issueProviderSelection({ binding, api: binding.match.api, rungId: rung.id, ordinal: rung.ordinal, effort: rung.providerValue })
        : undefined;
    }
    return deepFreeze({ initial, evidence, manual, provider });
  } catch { return undefined; }
}

function issueSnapshot<T extends ProfileActivationSnapshot>(snapshot: T): T {
  const frozen = deepFreeze(snapshot);
  issuedSnapshots.add(frozen);
  return frozen;
}

function issueProviderSelection<T extends BoundProviderSelection>(selection: T): T {
  const frozen = deepFreeze(selection);
  issuedProviderSelections.add(frozen);
  return frozen;
}

function bindingFromValidatedProfiles(
  capability: ReasoningCapabilityProfile,
  admission: AdmissionProfile,
): ProfileBindingResult {
  bindingDigestCount += 2;
  const capabilityDigest = canonicalProfileDigest(capability);
  if (!capabilityDigest.ok) return capabilityDigest;
  const admissionDigest = canonicalProfileDigest(admission);
  if (!admissionDigest.ok) return admissionDigest;
  return {
    ok: true,
    binding: {
      capability: {
        profileId: capability.profileId,
        profileRevision: capability.profileRevision,
        profileDigest: capabilityDigest.digest,
      },
      admission: {
        profileId: admission.profileId,
        profileRevision: admission.profileRevision,
        profileDigest: admissionDigest.digest,
      },
      match: capability.match,
    },
  };
}

function parseCapabilityProfile(value: unknown): ReasoningCapabilityProfile | undefined {
  try {
    const record = exactRecord(value, [
      "schemaVersion",
      "profileId",
      "profileRevision",
      "source",
      "match",
      "rungs",
      "automaticFloor",
      "automaticCeiling",
      "anchors",
      "baselineBehavior",
    ], ["explicitCeiling"]);
    if (!record || record.schemaVersion !== 1) return undefined;
    const profileId = requiredString(record.profileId);
    const profileRevision = requiredString(record.profileRevision);
    const source = parseProfileSource(record.source);
    const match = parseProfileMatch(record.match);
    const automaticFloor = requiredString(record.automaticFloor);
    const automaticCeiling = requiredString(record.automaticCeiling);
    if (Object.hasOwn(record, "explicitCeiling") && record.explicitCeiling === undefined) return undefined;
    const explicitCeiling = record.explicitCeiling === undefined
      ? undefined
      : requiredString(record.explicitCeiling);
    const anchorsRecord = exactRecord(record.anchors, ADMISSION_ANCHORS);
    if (!profileId || !profileRevision || !source || !match || !automaticFloor || !automaticCeiling || !anchorsRecord) {
      return undefined;
    }
    if (record.explicitCeiling !== undefined && !explicitCeiling) {
      return undefined;
    }
    if (record.baselineBehavior !== "preserve-request" && record.baselineBehavior !== "known-profile-default") {
      return undefined;
    }
    if (!isDensePlainArray(record.rungs) || record.rungs.length < 2) {
      return undefined;
    }
    const rungs: ReasoningRung[] = [];
    const ids = new Set<string>();
    const aliases = new Set<string>();
    let previousOrdinal = -1;
    for (const valueRung of record.rungs) {
      const rung = parseRung(valueRung);
      if (!rung || rung.ordinal <= previousOrdinal || ids.has(rung.id) || aliases.has(rung.id)) return undefined;
      previousOrdinal = rung.ordinal;
      ids.add(rung.id);
      for (const alias of rung.aliases ?? []) {
        if (ids.has(alias) || aliases.has(alias)) return undefined;
        aliases.add(alias);
      }
      rungs.push(rung);
    }
    const byId = new Map(rungs.map((rung) => [rung.id, rung]));
    const floor = byId.get(automaticFloor);
    const ceiling = byId.get(automaticCeiling);
    const explicit = explicitCeiling === undefined ? undefined : byId.get(explicitCeiling);
    if (!floor?.automaticEligible || !ceiling?.automaticEligible || floor.ordinal > ceiling.ordinal) return undefined;
    if (explicitCeiling === undefined) {
      if (rungs.some((rung) => rung.explicitOnly)) return undefined;
    } else if (!explicit?.explicitOnly || explicit.automaticEligible || explicit.ordinal < ceiling.ordinal) {
      return undefined;
    }
    if (rungs.some((rung) => rung.automaticEligible && (rung.ordinal < floor.ordinal || rung.ordinal > ceiling.ordinal))) {
      return undefined;
    }
    if (rungs.some((rung) => rung.explicitOnly && rung.ordinal < ceiling.ordinal)) return undefined;
    const manualCeiling = explicit ?? ceiling;
    if (rungs.some((rung) => rung.ordinal <= manualCeiling.ordinal && (!isCommandSafeToken(rung.id) || (rung.aliases ?? []).some((alias) => !isCommandSafeToken(alias))))) {
      return undefined;
    }
    const anchors = {} as Record<AdmissionAnchor, RungId>;
    for (const anchor of ADMISSION_ANCHORS) {
      const rungId = requiredString(anchorsRecord[anchor]);
      const rung = rungId ? byId.get(rungId) : undefined;
      if (!rungId || !rung?.automaticEligible || rung.ordinal < floor.ordinal || rung.ordinal > ceiling.ordinal) {
        return undefined;
      }
      anchors[anchor] = rungId;
    }
    return {
      schemaVersion: 1,
      profileId,
      profileRevision,
      source,
      match,
      rungs,
      automaticFloor,
      automaticCeiling,
      ...(explicitCeiling === undefined ? {} : { explicitCeiling }),
      anchors,
      baselineBehavior: record.baselineBehavior,
    };
  } catch {
    return undefined;
  }
}

function parseRung(value: unknown): ReasoningRung | undefined {
  const record = exactRecord(value, [
    "id",
    "ordinal",
    "providerValue",
    "automaticEligible",
    "explicitOnly",
  ], ["aliases"]);
  if (!record) return undefined;
  const id = requiredString(record.id);
  if (!id || !Number.isSafeInteger(record.ordinal) || (record.ordinal as number) < 0) return undefined;
  if (typeof record.automaticEligible !== "boolean" || typeof record.explicitOnly !== "boolean") return undefined;
  if (record.automaticEligible === record.explicitOnly) return undefined;
  const providerValue = canonicalJson(record.providerValue);
  if (!providerValue.ok) return undefined;
  let aliases: readonly string[] | undefined;
  if (Object.hasOwn(record, "aliases") && record.aliases === undefined) return undefined;
  if (record.aliases !== undefined) {
    if (!isDensePlainArray(record.aliases)) return undefined;
    const parsedAliases = record.aliases.map(requiredString);
    if (parsedAliases.some((alias) => alias === undefined) || new Set(parsedAliases).size !== parsedAliases.length) return undefined;
    aliases = parsedAliases as string[];
  }
  return {
    id,
    ordinal: record.ordinal as number,
    providerValue: JSON.parse(providerValue.canonical) as CanonicalData,
    automaticEligible: record.automaticEligible,
    explicitOnly: record.explicitOnly,
    ...(aliases === undefined ? {} : { aliases }),
  };
}

function parseAdmissionProfile(
  value: unknown,
  capability: ReasoningCapabilityProfile,
): AdmissionProfile | undefined {
  try {
    const record = exactRecord(value, [
      "schemaVersion",
      "profileId",
      "profileRevision",
      "source",
      "capabilityProfileId",
      "capabilityProfileRevision",
      "initial",
      "evidence",
    ]);
    if (!record || record.schemaVersion !== 1) return undefined;
    const profileId = requiredString(record.profileId);
    const profileRevision = requiredString(record.profileRevision);
    const source = parseProfileSource(record.source);
    if (!profileId || !profileRevision || !source) return undefined;
    if (record.capabilityProfileId !== capability.profileId || record.capabilityProfileRevision !== capability.profileRevision) {
      return undefined;
    }
    const initialRecord = exactRecord(record.initial, INITIAL_KEYS);
    const evidenceRecord = exactRecord(record.evidence, EVIDENCE_KEYS);
    if (!initialRecord || !evidenceRecord) return undefined;
    const initial = {} as Record<InitialAdmissionKey, RungSelector>;
    for (const key of INITIAL_KEYS) {
      const selector = parseSelector(initialRecord[key]);
      if (!selector || !selectorFeasible(selector, capability)) return undefined;
      initial[key] = selector;
    }
    const evidence = {} as Record<EvidenceAdmissionKey, EscalationRule>;
    for (const key of EVIDENCE_KEYS) {
      const ruleRecord = exactRecord(evidenceRecord[key], ["selector"]);
      const selector = ruleRecord ? parseSelector(ruleRecord.selector) : undefined;
      if (!selector || !selectorFeasible(selector, capability)) return undefined;
      evidence[key] = { selector };
    }
    return {
      schemaVersion: 1,
      profileId,
      profileRevision,
      source,
      capabilityProfileId: capability.profileId,
      capabilityProfileRevision: capability.profileRevision,
      initial,
      evidence,
    };
  } catch {
    return undefined;
  }
}

function parseSelector(value: unknown): RungSelector | undefined {
  const kindOnly = exactRecord(value, ["kind"]);
  if (kindOnly) {
    if (
      kindOnly.kind === "lowest-automatic"
      || kindOnly.kind === "next-above-lowest"
      || kindOnly.kind === "next-below-ceiling"
      || kindOnly.kind === "automatic-ceiling"
    ) {
      return { kind: kindOnly.kind };
    }
    return undefined;
  }
  const anchor = exactRecord(value, ["kind", "name"]);
  if (anchor?.kind !== "anchor" || !isAdmissionAnchor(anchor.name)) return undefined;
  return { kind: "anchor", name: anchor.name };
}

function parseProfileSource(value: unknown): ProfileSource | undefined {
  const repository = exactRecord(value, ["kind", "repositoryRevision"]);
  if (repository?.kind === "repository-pinned") {
    const repositoryRevision = requiredString(repository.repositoryRevision);
    return repositoryRevision ? { kind: "repository-pinned", repositoryRevision } : undefined;
  }
  const local = exactRecord(value, ["kind", "approvalDigest"]);
  if (local?.kind === "user-approved-local" && isDigest(local.approvalDigest)) {
    return { kind: "user-approved-local", approvalDigest: local.approvalDigest };
  }
  const candidate = exactRecord(value, ["kind", "authority", "evidenceDigest"]);
  if (
    candidate?.kind === "validated-catalog-candidate"
    && candidate.authority === "candidate-only"
    && isDigest(candidate.evidenceDigest)
  ) {
    return {
      kind: "validated-catalog-candidate",
      authority: "candidate-only",
      evidenceDigest: candidate.evidenceDigest,
    };
  }
  return undefined;
}

function parseProfileMatch(value: unknown): ProfileMatch | undefined {
  const record = exactRecord(value, MATCH_KEYS);
  if (!record) return undefined;
  const parsed = Object.fromEntries(MATCH_KEYS.map((key) => [key, requiredString(record[key])])) as
    Partial<Record<(typeof MATCH_KEYS)[number], string>>;
  if (MATCH_KEYS.some((key) => !parsed[key])) return undefined;
  if (!isDigest(parsed.modelCatalogDigest) || !isDigest(parsed.providerAdapterDigest)) return undefined;
  return parsed as ProfileMatch;
}

function parseProfileIdentity(value: unknown): ProfileIdentity | undefined {
  const record = exactRecord(value, PROFILE_IDENTITY_KEYS);
  if (!record) return undefined;
  const profileId = requiredString(record.profileId);
  const profileRevision = requiredString(record.profileRevision);
  if (!profileId || !profileRevision || !isDigest(record.profileDigest)) return undefined;
  return { profileId, profileRevision, profileDigest: record.profileDigest };
}

function parseProfileBinding(value: unknown): ProfileBinding | undefined {
  try {
    const record = exactRecord(value, ["capability", "admission", "match"]);
    if (!record) return undefined;
    const capability = parseProfileIdentity(record.capability);
    const admission = parseProfileIdentity(record.admission);
    const match = parseProfileMatch(record.match);
    return capability && admission && match ? { capability, admission, match } : undefined;
  } catch {
    return undefined;
  }
}

function parseIdentityEnvelope(
  value: unknown,
): { readonly match: ProfileMatch; readonly profileBinding: unknown } | undefined {
  try {
    const record = exactRecord(value, ["match", "profileBinding"]);
    const match = record ? parseProfileMatch(record.match) : undefined;
    return record && match ? { match, profileBinding: record.profileBinding } : undefined;
  } catch {
    return undefined;
  }
}

function exactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    return undefined;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return undefined;
  const expected = new Set([...requiredKeys, ...optionalKeys]);
  if (keys.some((key) => typeof key !== "string" || !expected.has(key))) return undefined;
  if (requiredKeys.some((key) => !keys.includes(key))) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const record: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) return undefined;
    record[key] = descriptor.value;
  }
  return record;
}

function isDensePlainArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  const expected = new Set<string>(["length"]);
  for (let index = 0; index < value.length; index += 1) expected.add(String(index));
  if (keys.some((key) => typeof key !== "string" || !expected.has(key))) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) return false;
  }
  return true;
}

function selectorFeasible(
  selector: RungSelector,
  capability: ReasoningCapabilityProfile,
): boolean {
  const automatic = automaticRungs(capability);
  if (selector.kind === "next-above-lowest" || selector.kind === "next-below-ceiling") {
    return automatic.length >= 2;
  }
  if (selector.kind === "anchor") {
    return automatic.some((rung) => rung.id === capability.anchors[selector.name]);
  }
  return automatic.length >= 1;
}

function automaticRungs(capability: ReasoningCapabilityProfile): readonly ReasoningRung[] {
  const floor = capability.rungs.find((rung) => rung.id === capability.automaticFloor)!;
  const ceiling = capability.rungs.find((rung) => rung.id === capability.automaticCeiling)!;
  return capability.rungs.filter(
    (rung) => rung.automaticEligible && rung.ordinal >= floor.ordinal && rung.ordinal <= ceiling.ordinal,
  );
}

function selectAutomatic(
  selector: RungSelector,
  capability: ReasoningCapabilityProfile,
  automatic: readonly ReasoningRung[],
): ReasoningRung | undefined {
  if (selector.kind === "lowest-automatic") return automatic[0];
  if (selector.kind === "next-above-lowest") return automatic[1];
  if (selector.kind === "next-below-ceiling") return automatic.at(-2);
  if (selector.kind === "automatic-ceiling") return automatic.at(-1);
  return automatic.find((rung) => rung.id === capability.anchors[selector.name]);
}

function sameMatch(left: ProfileMatch, right: ProfileMatch): boolean {
  return MATCH_KEYS.every((key) => left[key] === right[key]);
}

function sameIdentity(left: ProfileIdentity, right: ProfileIdentity): boolean {
  return PROFILE_IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

function sameBinding(left: ProfileBinding, right: ProfileBinding): boolean {
  return sameIdentity(left.capability, right.capability)
    && sameIdentity(left.admission, right.admission)
    && sameMatch(left.match, right.match);
}

/** Fieldwise binding equality; profile-local ordinals are comparable only when true. */
export function sameProfileBinding(left: ProfileBinding, right: ProfileBinding): boolean {
  return sameBinding(left, right);
}

/** Fieldwise comparison used by the runtime without recomputing profile digests. */
export function sameProfileMatch(left: ProfileMatch, right: ProfileMatch): boolean {
  return sameMatch(left, right);
}

function detachedCanonicalCopy(value: unknown): unknown | undefined {
  const canonical = canonicalJson(value);
  if (!canonical.ok) return undefined;
  try { return JSON.parse(canonical.canonical); } catch { return undefined; }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  return Object.freeze(value);
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function isAdmissionAnchor(value: unknown): value is AdmissionAnchor {
  return typeof value === "string" && (ADMISSION_ANCHORS as readonly string[]).includes(value);
}

function hasAdmissionAuthority(source: ProfileSource): boolean {
  return source.kind === "repository-pinned" || source.kind === "user-approved-local";
}
