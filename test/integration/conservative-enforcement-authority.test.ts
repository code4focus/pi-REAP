import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const authoritySeam = vi.hoisted(() => ({
  calls: 0,
  candidate: undefined as unknown,
  may: (_qualification: unknown, _binding: unknown, _now?: number): boolean => false,
}));
vi.mock("../../src/qualification/enforcement.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/qualification/enforcement.js")>();
  return {
    ...actual,
    mayProductionSessionEnforce: (binding: unknown, now?: number): boolean => {
      authoritySeam.calls += 1;
      return authoritySeam.may(authoritySeam.candidate, binding, now);
    },
  };
});

import { createProfileBinding } from "../../src/domain/profile.js";
import { createExtension } from "../../src/index.js";
import {
  canonicalProfileQualificationArtifactDigest,
  canonicalProfileQualificationAttestationBytes,
  createQualificationVerifier,
  isTrustedProfileQualification,
  verifyProductionProfileQualification,
  type ProfileQualificationArtifact,
  type ProfileQualificationAttestation,
  type ProfileQualificationBundle,
  type ProfileQualificationEvidence,
} from "../../src/qualification/enforcement.js";
import { profileFixtures } from "../../eval/corpus/manifest.js";
import { withoutReasoningEffort } from "../../src/provider/patch.js";
import { ExtensionHarness } from "./extension-harness.js";

const hash = (letter: string): string => letter.repeat(64);
const authority = "isolated-vitest-extension-authority-v1";
const issuedAt = "2026-07-27T12:00:00Z";
const expiresAt = "2026-07-27T12:30:00Z";
const initialNow = Date.parse("2026-07-27T12:05:00Z");
const profile = profileFixtures.twoRung;
const activation = {
  capability: profile.capability,
  admission: profile.admission,
  modelCatalogRevision: profile.capability.match.modelCatalogRevision,
  modelCatalogDigest: profile.capability.match.modelCatalogDigest,
  piVersion: profile.capability.match.piVersion,
  providerAdapterRevision: profile.capability.match.providerAdapterRevision,
  providerAdapterDigest: profile.capability.match.providerAdapterDigest,
};
const binding = (() => {
  const result = createProfileBinding(profile.capability, profile.admission);
  if (!result.ok) throw new Error("synthetic extension profile must bind");
  return result.binding;
})();
const keyPair = generateKeyPairSync("ed25519");
const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
const publicKeyDigest = createHash("sha256").update(keyPair.publicKey.export({ type: "spki", format: "der" })).digest("hex");
const evidence: ProfileQualificationEvidence = {
  binding,
  sources: { capability: profile.capability.source, admission: profile.admission.source },
  environment: binding.match,
  pr5: { corpusDigest: hash("a"), oracleDigest: hash("b"), observedImplementationDigest: hash("c"), reportDigest: hash("d"), sourceFingerprint: hash("e"), extensionBuildFingerprint: hash("f") },
  adapter: { mappingDigest: hash("1"), payloadCanonical: true },
  quality: { allowancePassed: true, regressionFixturesDigest: hash("2") },
  underRouting: { disposition: "reviewed", reviewRecordsDigest: hash("3") },
  requests: { baseline: 2, enforced: 2, retries: 0, noAmplification: true },
  cache: { groupsDigest: hash("4"), profileBindingDigest: hash("5"), environmentDigest: hash("6"), protocolDigest: hash("7"), authorizationDigest: hash("8"), rawFieldObservability: "observed", positiveControlCachedTokens: 10, crossoverCachedTokens: 8, verdict: "PASS" },
  approval: { authority, digest: hash("9"), revalidationDigest: hash("0"), expiresAt, offlineSessionOptIn: false },
};
const artifact: ProfileQualificationArtifact = { schemaVersion: 1, evidence };
const artifactDigest = canonicalProfileQualificationArtifactDigest(artifact);
if (!artifactDigest) throw new Error("synthetic qualification artifact must be canonical");
const unsigned: ProfileQualificationAttestation = {
  schemaVersion: 1,
  artifactDigest,
  authority,
  authorityKeyDigest: publicKeyDigest,
  approvalDigest: evidence.approval.digest,
  issuedAt,
  expiresAt,
  nonce: hash("a"),
  signature: "pending",
};
const attestationBytes = canonicalProfileQualificationAttestationBytes(unsigned);
if (!attestationBytes) throw new Error("synthetic qualification attestation must be canonical");
const bundle: ProfileQualificationBundle = { artifact, attestation: { ...unsigned, signature: sign(null, attestationBytes, keyPair.privateKey).toString("base64") } };
const verifier = createQualificationVerifier({ authority, publicKey, approvedArtifactDigests: [artifactDigest], maxValidityMs: 3_600_000, allowOfflineSessionOptIn: false });
const qualification = verifier.verify(bundle, initialNow);
if (!qualification) throw new Error("isolated test authority must verify its signed fixture");
const config = async () => ({ enabled: true, mode: "enforce" as const, telemetry: { enabled: false, includePromptText: false, directory: "synthetic" }, ui: { showStatus: true, notifyOnEscalation: false } });
const begin = (harness: ExtensionHarness, prompt = "What is JSON?"): void => { harness.input(prompt); harness.before(prompt); };

describe("isolated positive conservative-enforcement composition", () => {
  it("applies request-locally, revalidates every hook, and revokes on expiry/profile/session/evidence boundaries", async () => {
    vi.useFakeTimers();
    authoritySeam.calls = 0;
    authoritySeam.candidate = qualification;
    authoritySeam.may = (candidate, candidateBinding, now) => verifier.maySessionEnforce(candidate as typeof qualification, candidateBinding as typeof binding, now);
    try {
      vi.setSystemTime(initialNow);
      const harness = new ExtensionHarness(); harness.setModel({ id: profile.capability.match.model });
      await createExtension({ load: config, activation })(harness.api()); harness.start();
      const original = { input: "synthetic", prompt_cache_key: "cache", reasoning: { effort: "baseline", context: "opaque" }, transport: { retries: 2 } };
      begin(harness); expect(harness.request(original)).toBeUndefined();
      await harness.commands.get("effort")!.handler("enforce", harness.context);
      const first = harness.request(original); const second = harness.request(original);
      expect(first).toBeDefined(); expect(second).toBeDefined();
      expect(withoutReasoningEffort(first)).toStrictEqual(withoutReasoningEffort(original));
      expect((first as { reasoning: { effort: string } }).reasoning.effort).toBe(profile.capability.rungs[0]!.providerValue);
      expect(authoritySeam.calls).toBeGreaterThanOrEqual(3);

      vi.setSystemTime(Date.parse(expiresAt) + 1);
      expect(harness.request(original)).toBeUndefined();
      expect(harness.status.get("pi-reap")).toContain("mode:shadow");

      vi.setSystemTime(initialNow);
      await harness.commands.get("effort")!.handler("enforce", harness.context);
      harness.setModel({ provider: "other" });
      expect(harness.request(original)).toBeUndefined();
      expect(harness.status.get("pi-reap")).toContain("profile:unresolved");

      const reset = new ExtensionHarness(); reset.setModel({ id: profile.capability.match.model });
      await createExtension({ load: config, activation })(reset.api()); reset.start();
      await reset.commands.get("effort")!.handler("enforce", reset.context); reset.shutdown(); reset.start(); begin(reset);
      expect(reset.request(original)).toBeUndefined();
      expect(reset.status.get("pi-reap")).toContain("mode:shadow");

      const forged = { ...qualification, artifact: { ...qualification.artifact, evidence: { ...qualification.artifact.evidence, approval: { ...qualification.artifact.evidence.approval, revalidationDigest: hash("f") } } } };
      authoritySeam.candidate = forged;
      const mutated = new ExtensionHarness(); mutated.setModel({ id: profile.capability.match.model });
      await createExtension({ load: config, activation })(mutated.api()); mutated.start();
      await mutated.commands.get("effort")!.handler("enforce", mutated.context); begin(mutated);
      expect(mutated.request(original)).toBeUndefined();
      expect(mutated.status.get("pi-reap")).toContain("mode:shadow");

      expect(isTrustedProfileQualification(qualification)).toBe(false);
      expect(verifyProductionProfileQualification(bundle, initialNow)).toBeUndefined();
    } finally {
      authoritySeam.candidate = undefined;
      authoritySeam.may = () => false;
      vi.useRealTimers();
    }
  });
});
