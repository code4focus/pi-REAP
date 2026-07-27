import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { canonicalJson, canonicalProfileDigest } from "../domain/canonical-json.js";
import { sameProfileBinding, sameProfileMatch, type ProfileBinding, type ProfileMatch, type ProfileSource } from "../domain/profile.js";

export type CacheQualificationVerdict = "PASS" | "REGRESSION" | "ENVIRONMENT_UNQUALIFIED" | "OBSERVABILITY_UNAVAILABLE";

/** Closed, prompt-free output of the PR5 evaluation and PR6 approval gates. */
export interface ProfileQualificationEvidence {
  readonly binding: ProfileBinding;
  readonly sources: { readonly capability: ProfileSource; readonly admission: ProfileSource };
  readonly environment: ProfileMatch;
  readonly pr5: {
    readonly corpusDigest: string;
    readonly oracleDigest: string;
    readonly observedImplementationDigest: string;
    readonly reportDigest: string;
    readonly sourceFingerprint: string;
    readonly extensionBuildFingerprint: string;
  };
  readonly adapter: { readonly mappingDigest: string; readonly payloadCanonical: true };
  readonly quality: { readonly allowancePassed: true; readonly regressionFixturesDigest: string };
  readonly underRouting: { readonly disposition: "reviewed"; readonly reviewRecordsDigest: string };
  readonly requests: { readonly baseline: number; readonly enforced: number; readonly retries: number; readonly noAmplification: true };
  readonly cache: {
    readonly groupsDigest: string;
    readonly profileBindingDigest: string;
    readonly environmentDigest: string;
    readonly protocolDigest: string;
    readonly authorizationDigest: string;
    readonly rawFieldObservability: "observed" | "unavailable";
    readonly positiveControlCachedTokens?: number;
    readonly crossoverCachedTokens?: number;
    readonly verdict: CacheQualificationVerdict;
  };
  readonly approval: {
    readonly authority: string;
    readonly digest: string;
    readonly revalidationDigest: string;
    readonly expiresAt: string;
    /** Offline evidence may only authorize the explicit session-local command. */
    readonly offlineSessionOptIn: boolean;
  };
}

export interface ProfileQualificationArtifact {
  readonly schemaVersion: 1;
  readonly evidence: ProfileQualificationEvidence;
}

export interface ProfileQualificationAttestation {
  readonly schemaVersion: 1;
  readonly artifactDigest: string;
  readonly authority: string;
  readonly authorityKeyDigest: string;
  readonly approvalDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly signature: string;
}

export interface ProfileQualificationBundle {
  readonly artifact: ProfileQualificationArtifact;
  readonly attestation: ProfileQualificationAttestation;
}

export interface QualificationAuthority {
  readonly authority: string;
  readonly publicKey: string;
  readonly approvedArtifactDigests: readonly string[];
  readonly maxValidityMs: number;
  readonly allowOfflineSessionOptIn: boolean;
}

export interface ProfileQualification {
  readonly artifact: ProfileQualificationArtifact;
  readonly attestation: ProfileQualificationAttestation;
  readonly artifactDigest: string;
}

export type QualificationDisposition = "SESSION_OPT_IN" | "AUTOMATIC_PROMOTION" | "ENVIRONMENT_UNQUALIFIED" | "OBSERVABILITY_UNAVAILABLE";

export interface QualificationVerifier {
  verify(bundle: unknown, now?: number): ProfileQualification | undefined;
  isTrusted(value: unknown): value is ProfileQualification;
  maySessionEnforce(value: ProfileQualification | undefined, binding: ProfileBinding | undefined, now?: number): boolean;
  mayAutomaticallyPromote(value: ProfileQualification | undefined, binding: ProfileBinding | undefined, now?: number): boolean;
  disposition(value: ProfileQualification | undefined, binding: ProfileBinding | undefined, now?: number): QualificationDisposition;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const evidenceKeys = ["binding", "sources", "environment", "pr5", "adapter", "quality", "underRouting", "requests", "cache", "approval"] as const;
const bindingKeys = ["capability", "admission", "match"] as const;
const identityKeys = ["profileId", "profileRevision", "profileDigest"] as const;
const matchKeys = ["provider", "api", "model", "modelCatalogRevision", "modelCatalogDigest", "piVersion", "providerAdapterRevision", "providerAdapterDigest"] as const;
const artifactKeys = ["schemaVersion", "evidence"] as const;
const attestationKeys = ["schemaVersion", "artifactDigest", "authority", "authorityKeyDigest", "approvalDigest", "issuedAt", "expiresAt", "nonce", "signature"] as const;

/**
 * Creates an isolated verifier. Its issued tokens are recognized only by this
 * verifier instance; supplying another key or a lookalike token cannot cross an
 * authority boundary.
 */
export function createQualificationVerifier(authorityValue: QualificationAuthority): QualificationVerifier {
  const authority = validateAuthority(authorityValue);
  const issued = new WeakSet<object>();
  const consumed = new Set<string>();

  const isTrusted = (value: unknown): value is ProfileQualification => {
    try { return isRecord(value) && issued.has(value) && Object.isFrozen(value); } catch { return false; }
  };

  const stillValid = (value: ProfileQualification | undefined, binding: ProfileBinding | undefined, now: number): boolean => {
    if (!value || !binding || !isTrusted(value)) return false;
    const artifactDigest = digestCanonical(value.artifact);
    return artifactDigest !== undefined
      && artifactDigest === value.artifactDigest
      && artifactDigest === value.attestation.artifactDigest
      && authority.approvedArtifactDigests.has(artifactDigest)
      && exactEvidence(value.artifact.evidence, now)
      && sameProfileBinding(value.artifact.evidence.binding, binding)
      && exactAttestationBinding(value.artifact.evidence, value.attestation, authority, now);
  };

  const verifier: QualificationVerifier = {
    verify(bundleValue, now = Date.now()) {
      try {
        const bundle = cloneCanonical(bundleValue);
        if (!bundle || !isRecord(bundle)) return undefined;
        exactKeys(bundle, ["artifact", "attestation"], "qualification bundle");
        const artifact = bundle.artifact;
        const attestation = bundle.attestation;
        if (!isRecord(artifact) || !isRecord(attestation)) return undefined;
        exactKeys(artifact, artifactKeys, "qualification artifact");
        exactKeys(attestation, attestationKeys, "qualification attestation");
        if (artifact.schemaVersion !== 1 || attestation.schemaVersion !== 1) return undefined;
        const evidence = artifact.evidence as ProfileQualificationEvidence;
        const typedAttestation = attestation as unknown as ProfileQualificationAttestation;
        const artifactDigest = digestCanonical(artifact);
        if (!artifactDigest || !authority.approvedArtifactDigests.has(artifactDigest) || !exactEvidence(evidence, now)) return undefined;
        if (!exactAttestationBinding(evidence, typedAttestation, authority, now) || typedAttestation.artifactDigest !== artifactDigest) return undefined;
        const replayKey = `${typedAttestation.authorityKeyDigest}:${typedAttestation.nonce}:${artifactDigest}`;
        if (consumed.has(replayKey)) return undefined;
        const signature = decodeSignature(typedAttestation.signature);
        const bytes = canonicalProfileQualificationAttestationBytes(typedAttestation);
        if (!signature || !bytes || !verifySignature(null, bytes, authority.publicKey, signature)) return undefined;
        consumed.add(replayKey);
        const qualification = deepFreeze({
          artifact: artifact as unknown as ProfileQualificationArtifact,
          attestation: typedAttestation,
          artifactDigest,
        });
        issued.add(qualification);
        return qualification;
      } catch {
        return undefined;
      }
    },
    isTrusted,
    maySessionEnforce(value, binding, now = Date.now()) {
      if (!stillValid(value, binding, now)) return false;
      const evidence = value!.artifact.evidence;
      return evidence.cache.verdict === "PASS"
        || (authority.allowOfflineSessionOptIn
          && evidence.approval.offlineSessionOptIn
          && evidence.cache.verdict === "OBSERVABILITY_UNAVAILABLE");
    },
    mayAutomaticallyPromote(value, binding, now = Date.now()) {
      if (!stillValid(value, binding, now)) return false;
      const cache = value!.artifact.evidence.cache;
      return cache.rawFieldObservability === "observed"
        && cache.verdict === "PASS"
        && (cache.positiveControlCachedTokens ?? 0) > 0
        && (cache.crossoverCachedTokens ?? 0) > 0;
    },
    disposition(value, binding, now = Date.now()) {
      if (!verifier.maySessionEnforce(value, binding, now)) return "ENVIRONMENT_UNQUALIFIED";
      if (value!.artifact.evidence.cache.verdict === "OBSERVABILITY_UNAVAILABLE") return "OBSERVABILITY_UNAVAILABLE";
      return verifier.mayAutomaticallyPromote(value, binding, now) ? "AUTOMATIC_PROMOTION" : "SESSION_OPT_IN";
    },
  };
  return Object.freeze(verifier);
}

/**
 * Production authority pin. PR6 intentionally bundles no approved successor
 * artifact digest, so current production qualification attempts fail closed
 * until an independently approved exact-profile artifact is supplied later.
 */
const productionAuthority = createQualificationVerifier({
  authority: "pi-reap-independent-qualification-v1",
  publicKey: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA9wzd/U+UeerCqYsHNyimuNfGG2Tmi2XI233FeVAPJbU=\n-----END PUBLIC KEY-----\n",
  approvedArtifactDigests: [],
  maxValidityMs: 86_400_000,
  allowOfflineSessionOptIn: false,
});

export function verifyProductionProfileQualification(bundle: unknown, now = Date.now()): ProfileQualification | undefined {
  return productionAuthority.verify(bundle, now);
}
export function isTrustedProfileQualification(value: unknown): value is ProfileQualification {
  return productionAuthority.isTrusted(value);
}
export function maySessionEnforce(value: ProfileQualification | undefined, binding: ProfileBinding | undefined, now = Date.now()): boolean {
  return productionAuthority.maySessionEnforce(value, binding, now);
}
/**
 * Runtime enforcement owns no caller-supplied qualification seam. PR6 has no
 * bundled approved artifact, so the production extension remains fail-closed.
 * A later distribution slice may replace this internal source after approval.
 */
export function mayProductionSessionEnforce(binding: ProfileBinding | undefined, now = Date.now()): boolean {
  return productionAuthority.maySessionEnforce(undefined, binding, now);
}
export function mayAutomaticallyPromote(value: ProfileQualification | undefined, binding: ProfileBinding | undefined, now = Date.now()): boolean {
  return productionAuthority.mayAutomaticallyPromote(value, binding, now);
}
export function qualificationDisposition(value: ProfileQualification | undefined, binding: ProfileBinding | undefined, now = Date.now()): QualificationDisposition {
  return productionAuthority.disposition(value, binding, now);
}

export function canonicalProfileQualificationArtifactDigest(artifact: ProfileQualificationArtifact): string | undefined {
  return digestCanonical(artifact);
}

export function canonicalProfileQualificationAttestationBytes(attestation: ProfileQualificationAttestation): Buffer | undefined {
  try {
    const { signature: _signature, ...material } = attestation;
    const canonical = canonicalJson(material);
    return canonical.ok ? Buffer.from(canonical.canonical) : undefined;
  } catch {
    return undefined;
  }
}

function exactEvidence(value: ProfileQualificationEvidence, now: number): boolean {
  try {
    if (!isRecord(value)) return false;
    exactKeys(value, evidenceKeys, "qualification evidence");
    if (!isRecord(value.binding)) return false; exactKeys(value.binding, bindingKeys, "profile binding");
    for (const identity of [value.binding.capability, value.binding.admission]) {
      if (!isRecord(identity)) return false; exactKeys(identity, identityKeys, "profile identity");
      if (!nonEmpty(identity.profileId) || !nonEmpty(identity.profileRevision) || !digest(identity.profileDigest)) return false;
    }
    if (!isRecord(value.binding.match)) return false; exactKeys(value.binding.match, matchKeys, "profile match");
    if (!isRecord(value.environment)) return false; exactKeys(value.environment, matchKeys, "qualification environment");
    for (const key of matchKeys) if (!nonEmpty(value.binding.match[key]) || !nonEmpty(value.environment[key])) return false;
    if (!sameProfileMatch(value.binding.match, value.environment)) return false;
    if (!isRecord(value.sources)) return false; exactKeys(value.sources, ["capability", "admission"], "profile sources");
    if (!exactSource(value.sources.capability) || !exactSource(value.sources.admission)) return false;
    if (!isRecord(value.pr5)) return false; exactKeys(value.pr5, ["corpusDigest", "oracleDigest", "observedImplementationDigest", "reportDigest", "sourceFingerprint", "extensionBuildFingerprint"], "PR5 binding");
    if (!Object.values(value.pr5).every(digest)) return false;
    if (!isRecord(value.adapter)) return false; exactKeys(value.adapter, ["mappingDigest", "payloadCanonical"], "adapter evidence");
    if (!digest(value.adapter.mappingDigest) || value.adapter.payloadCanonical !== true) return false;
    if (!isRecord(value.quality)) return false; exactKeys(value.quality, ["allowancePassed", "regressionFixturesDigest"], "quality evidence");
    if (value.quality.allowancePassed !== true || !digest(value.quality.regressionFixturesDigest)) return false;
    if (!isRecord(value.underRouting)) return false; exactKeys(value.underRouting, ["disposition", "reviewRecordsDigest"], "under-routing evidence");
    if (value.underRouting.disposition !== "reviewed" || !digest(value.underRouting.reviewRecordsDigest)) return false;
    if (!isRecord(value.requests)) return false; exactKeys(value.requests, ["baseline", "enforced", "retries", "noAmplification"], "request evidence");
    if (!positiveCount(value.requests.baseline) || !positiveCount(value.requests.enforced) || !count(value.requests.retries)
      || value.requests.retries !== 0 || value.requests.noAmplification !== true || value.requests.enforced > value.requests.baseline) return false;
    if (!isRecord(value.cache)) return false;
    exactKeys(value.cache, ["groupsDigest", "profileBindingDigest", "environmentDigest", "protocolDigest", "authorizationDigest", "rawFieldObservability", "verdict"], "cache evidence", ["positiveControlCachedTokens", "crossoverCachedTokens"]);
    if (!digest(value.cache.groupsDigest) || !digest(value.cache.profileBindingDigest) || !digest(value.cache.environmentDigest)
      || !digest(value.cache.protocolDigest) || !digest(value.cache.authorizationDigest) || !exactCache(value.cache)) return false;
    if (!isRecord(value.approval)) return false;
    exactKeys(value.approval, ["authority", "digest", "revalidationDigest", "expiresAt", "offlineSessionOptIn"], "approval evidence");
    if (!nonEmpty(value.approval.authority) || !digest(value.approval.digest) || !digest(value.approval.revalidationDigest)
      || typeof value.approval.offlineSessionOptIn !== "boolean" || !future(value.approval.expiresAt, now)) return false;
    return canonicalProfileDigest(value).ok;
  } catch {
    return false;
  }
}

function exactCache(value: ProfileQualificationEvidence["cache"]): boolean {
  if (!["PASS", "REGRESSION", "ENVIRONMENT_UNQUALIFIED", "OBSERVABILITY_UNAVAILABLE"].includes(value.verdict)) return false;
  if (value.rawFieldObservability === "unavailable") {
    return value.positiveControlCachedTokens === undefined
      && value.crossoverCachedTokens === undefined
      && value.verdict === "OBSERVABILITY_UNAVAILABLE";
  }
  if (value.rawFieldObservability !== "observed" || !count(value.positiveControlCachedTokens) || !count(value.crossoverCachedTokens)) return false;
  const expected: CacheQualificationVerdict = value.positiveControlCachedTokens === 0
    ? "ENVIRONMENT_UNQUALIFIED"
    : value.crossoverCachedTokens === 0 ? "REGRESSION" : "PASS";
  return value.verdict === expected;
}

function exactAttestationBinding(
  evidence: ProfileQualificationEvidence,
  value: ProfileQualificationAttestation,
  authority: ReturnType<typeof validateAuthority>,
  now: number,
): boolean {
  if (!isRecord(value)) return false;
  exactKeys(value, attestationKeys, "qualification attestation");
  if (value.schemaVersion !== 1 || !digest(value.artifactDigest) || !digest(value.authorityKeyDigest)
    || !digest(value.approvalDigest) || !digest(value.nonce) || !nonEmpty(value.signature)) return false;
  const issued = Date.parse(value.issuedAt); const expires = Date.parse(value.expiresAt);
  return value.authority === authority.authority
    && value.authorityKeyDigest === authority.publicKeyDigest
    && value.approvalDigest === evidence.approval.digest
    && value.expiresAt === evidence.approval.expiresAt
    && evidence.approval.authority === authority.authority
    && Number.isFinite(issued) && Number.isFinite(expires)
    && issued <= now && now < expires && expires - issued > 0 && expires - issued <= authority.maxValidityMs;
}

function validateAuthority(value: QualificationAuthority): {
  readonly authority: string;
  readonly publicKey: string;
  readonly publicKeyDigest: string;
  readonly approvedArtifactDigests: ReadonlySet<string>;
  readonly maxValidityMs: number;
  readonly allowOfflineSessionOptIn: boolean;
} {
  if (!nonEmpty(value.authority) || !nonEmpty(value.publicKey) || !Number.isSafeInteger(value.maxValidityMs) || value.maxValidityMs <= 0
    || typeof value.allowOfflineSessionOptIn !== "boolean" || !Array.isArray(value.approvedArtifactDigests)
    || value.approvedArtifactDigests.some((item) => !digest(item))) throw new Error("invalid qualification authority");
  const key = createPublicKey(value.publicKey);
  const publicKeyDigest = createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
  return Object.freeze({
    authority: value.authority,
    publicKey: value.publicKey,
    publicKeyDigest,
    approvedArtifactDigests: new Set(value.approvedArtifactDigests),
    maxValidityMs: value.maxValidityMs,
    allowOfflineSessionOptIn: value.allowOfflineSessionOptIn,
  });
}

function exactSource(value: ProfileSource): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "repository-pinned") {
    exactKeys(value, ["kind", "repositoryRevision"], "repository source");
    return nonEmpty(value.repositoryRevision);
  }
  if (value.kind === "user-approved-local") {
    exactKeys(value, ["kind", "approvalDigest"], "local source");
    return digest(value.approvalDigest);
  }
  if (value.kind === "validated-catalog-candidate") {
    exactKeys(value, ["kind", "authority", "evidenceDigest"], "candidate source");
    return value.authority === "candidate-only" && digest(value.evidenceDigest);
  }
  return false;
}

function cloneCanonical(value: unknown): Record<string, unknown> | undefined {
  const canonical = canonicalJson(value);
  if (!canonical.ok) return undefined;
  return JSON.parse(canonical.canonical) as Record<string, unknown>;
}
function digestCanonical(value: unknown): string | undefined {
  const result = canonicalProfileDigest(value);
  return result.ok ? result.digest : undefined;
}
function decodeSignature(value: string): Buffer | undefined {
  if (!BASE64.test(value) || value.length === 0) return undefined;
  const decoded = Buffer.from(value, "base64");
  return decoded.length > 0 && decoded.toString("base64") === value ? decoded : undefined;
}
function exactKeys(value: Record<string, unknown>, required: readonly string[], name: string, optional: readonly string[] = []): void {
  const keys = Object.keys(value);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !required.includes(key) && !optional.includes(key))
    || keys.some((key) => value[key] === undefined)) throw new Error(`${name} has unknown, missing, or undefined fields`);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function digest(value: unknown): value is string { return typeof value === "string" && SHA256.test(value); }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function positiveCount(value: unknown): value is number { return count(value) && value > 0; }
function future(value: string, now: number): boolean { const parsed = Date.parse(value); return Number.isFinite(parsed) && parsed > now; }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
