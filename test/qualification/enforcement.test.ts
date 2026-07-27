import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createProfileBinding } from "../../src/domain/profile.js";
import {
  canonicalProfileQualificationArtifactDigest,
  canonicalProfileQualificationAttestationBytes,
  createQualificationVerifier,
  isTrustedProfileQualification,
  mayAutomaticallyPromote,
  maySessionEnforce,
  qualificationDisposition,
  verifyProductionProfileQualification,
  type ProfileQualificationArtifact,
  type ProfileQualificationAttestation,
  type ProfileQualificationBundle,
  type ProfileQualificationEvidence,
} from "../../src/qualification/enforcement.js";
import { profileFixtures } from "../../eval/corpus/manifest.js";

const hash = (letter: string) => letter.repeat(64);
const authority = "isolated-test-qualification-v1";
const issuedAt = "2026-07-27T12:00:00Z";
const expiresAt = "2026-07-27T12:30:00Z";
const now = Date.parse("2026-07-27T12:05:00Z");
const keyPair = generateKeyPairSync("ed25519");
const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
const binding = () => {
  const result = createProfileBinding(profileFixtures.multiRung.capability, profileFixtures.multiRung.admission);
  if (!result.ok) throw new Error("fixture must bind");
  return result.binding;
};
const evidence = (overrides: Partial<ProfileQualificationEvidence> = {}): ProfileQualificationEvidence => {
  const current = binding();
  return {
    binding: current,
    sources: { capability: profileFixtures.multiRung.capability.source, admission: profileFixtures.multiRung.admission.source },
    environment: current.match,
    pr5: { corpusDigest: hash("a"), oracleDigest: hash("b"), observedImplementationDigest: hash("c"), reportDigest: hash("d"), sourceFingerprint: hash("e"), extensionBuildFingerprint: hash("f") },
    adapter: { mappingDigest: hash("1"), payloadCanonical: true },
    quality: { allowancePassed: true, regressionFixturesDigest: hash("2") },
    underRouting: { disposition: "reviewed", reviewRecordsDigest: hash("3") },
    requests: { baseline: 2, enforced: 2, retries: 0, noAmplification: true },
    cache: { groupsDigest: hash("8"), profileBindingDigest: hash("9"), environmentDigest: hash("0"), protocolDigest: hash("4"), authorizationDigest: hash("5"), rawFieldObservability: "unavailable", verdict: "OBSERVABILITY_UNAVAILABLE" },
    approval: { authority, digest: hash("6"), revalidationDigest: hash("7"), expiresAt, offlineSessionOptIn: true },
    ...overrides,
  };
};
const artifact = (value = evidence()): ProfileQualificationArtifact => ({ schemaVersion: 1, evidence: value });
const bundle = (value = artifact()): ProfileQualificationBundle => {
  const artifactDigest = canonicalProfileQualificationArtifactDigest(value);
  if (!artifactDigest) throw new Error("fixture artifact must be canonical");
  const unsigned: ProfileQualificationAttestation = {
    schemaVersion: 1,
    artifactDigest,
    authority,
    authorityKeyDigest: hash("0"),
    approvalDigest: value.evidence.approval.digest,
    issuedAt,
    expiresAt: value.evidence.approval.expiresAt,
    nonce: hash("8"),
    signature: "pending",
  };
  const spkiDigest = (awaitablePublicKeyDigest());
  const material = { ...unsigned, authorityKeyDigest: spkiDigest };
  const bytes = canonicalProfileQualificationAttestationBytes(material);
  if (!bytes) throw new Error("fixture attestation must be canonical");
  return { artifact: value, attestation: { ...material, signature: sign(null, bytes, keyPair.privateKey).toString("base64") } };
};
const awaitablePublicKeyDigest = (): string => {
  return createHash("sha256").update(keyPair.publicKey.export({ type: "spki", format: "der" })).digest("hex");
};

describe("profile-bound conservative enforcement verifier", () => {
  it("isolates a signed test authority from the production extension authority", () => {
    const value = artifact();
    const digest = canonicalProfileQualificationArtifactDigest(value)!;
    const verifier = createQualificationVerifier({ authority, publicKey, approvedArtifactDigests: [digest], maxValidityMs: 3_600_000, allowOfflineSessionOptIn: true });
    const qualification = verifier.verify(bundle(value), now);
    expect(qualification).toBeDefined();
    expect(verifier.isTrusted(qualification)).toBe(true);
    expect(verifier.maySessionEnforce(qualification, binding(), now)).toBe(true);
    expect(verifier.mayAutomaticallyPromote(qualification, binding(), now)).toBe(false);
    expect(verifier.disposition(qualification, binding(), now)).toBe("OBSERVABILITY_UNAVAILABLE");
    expect(isTrustedProfileQualification(qualification)).toBe(false);
    expect(maySessionEnforce(qualification, binding(), now)).toBe(false);
    expect(mayAutomaticallyPromote(qualification, binding(), now)).toBe(false);
    expect(qualificationDisposition(qualification, binding(), now)).toBe("ENVIRONMENT_UNQUALIFIED");
    expect(verifyProductionProfileQualification(bundle(value), now)).toBeUndefined();
  });

  it("requires an exact raw-positive control and crossover for automatic eligibility", () => {
    const value = artifact(evidence({
      cache: { groupsDigest: hash("8"), profileBindingDigest: hash("9"), environmentDigest: hash("0"), protocolDigest: hash("4"), authorizationDigest: hash("5"), rawFieldObservability: "observed", positiveControlCachedTokens: 10, crossoverCachedTokens: 8, verdict: "PASS" },
    }));
    const verifier = createQualificationVerifier({ authority, publicKey, approvedArtifactDigests: [canonicalProfileQualificationArtifactDigest(value)!], maxValidityMs: 3_600_000, allowOfflineSessionOptIn: false });
    const qualification = verifier.verify(bundle(value), now);
    expect(verifier.maySessionEnforce(qualification, binding(), now)).toBe(true);
    expect(verifier.mayAutomaticallyPromote(qualification, binding(), now)).toBe(true);
  });

  it("rejects replay, expiry, signature mutation, and every exact evidence mutation", () => {
    const value = artifact(); const signed = bundle(value);
    const digest = canonicalProfileQualificationArtifactDigest(value)!;
    const verifier = createQualificationVerifier({ authority, publicKey, approvedArtifactDigests: [digest], maxValidityMs: 3_600_000, allowOfflineSessionOptIn: true });
    const qualification = verifier.verify(signed, now);
    expect(qualification).toBeDefined();
    expect(verifier.verify(signed, now)).toBeUndefined();
    expect(verifier.maySessionEnforce(qualification, binding(), Date.parse(expiresAt) + 1)).toBe(false);
    expect(createQualificationVerifier({ authority, publicKey, approvedArtifactDigests: [digest], maxValidityMs: 3_600_000, allowOfflineSessionOptIn: true })
      .verify({ ...signed, attestation: { ...signed.attestation, signature: "AA==" } }, now)).toBeUndefined();
    const attestationMutations: unknown[] = [
      { ...signed, attestation: { ...signed.attestation, artifactDigest: hash("9") } },
      { ...signed, attestation: { ...signed.attestation, authority: "attacker" } },
      { ...signed, attestation: { ...signed.attestation, authorityKeyDigest: hash("9") } },
      { ...signed, attestation: { ...signed.attestation, approvalDigest: hash("9") } },
      { ...signed, attestation: { ...signed.attestation, issuedAt: "2026-07-27T12:06:00Z" } },
      { ...signed, attestation: { ...signed.attestation, expiresAt: "2026-07-27T12:31:00Z" } },
      { ...signed, attestation: { ...signed.attestation, nonce: hash("9") } },
      { ...signed, attestation: { ...signed.attestation, attacker: true } },
      { ...signed, artifact: { ...signed.artifact, attacker: true } },
    ];
    for (const mutation of attestationMutations) {
      const isolated = createQualificationVerifier({ authority, publicKey, approvedArtifactDigests: [digest], maxValidityMs: 3_600_000, allowOfflineSessionOptIn: true });
      expect(isolated.verify(mutation, now)).toBeUndefined();
    }

    const mutations: ProfileQualificationEvidence[] = [
      evidence({ binding: { ...binding(), capability: { ...binding().capability, profileDigest: hash("9") } } }),
      evidence({ sources: { capability: { kind: "repository-pinned", repositoryRevision: "other" }, admission: profileFixtures.multiRung.admission.source } }),
      evidence({ environment: { ...binding().match, api: "other" } }),
      evidence({ pr5: { ...evidence().pr5, reportDigest: hash("9") } }),
      evidence({ adapter: { mappingDigest: hash("9"), payloadCanonical: true } }),
      evidence({ quality: { allowancePassed: true, regressionFixturesDigest: hash("9") } }),
      evidence({ underRouting: { disposition: "reviewed", reviewRecordsDigest: hash("9") } }),
      evidence({ requests: { baseline: 2, enforced: 3, retries: 0, noAmplification: true } }),
      evidence({ cache: { groupsDigest: hash("8"), profileBindingDigest: hash("9"), environmentDigest: hash("0"), protocolDigest: hash("4"), authorizationDigest: hash("5"), rawFieldObservability: "observed", positiveControlCachedTokens: 0, crossoverCachedTokens: 0, verdict: "PASS" } }),
      evidence({ approval: { ...evidence().approval, revalidationDigest: hash("9") } }),
    ];
    for (const mutated of mutations) {
      const mutatedArtifact = artifact(mutated);
      const isolated = createQualificationVerifier({ authority, publicKey, approvedArtifactDigests: [digest], maxValidityMs: 3_600_000, allowOfflineSessionOptIn: true });
      expect(isolated.verify(bundle(mutatedArtifact), now)).toBeUndefined();
    }
  });
});
