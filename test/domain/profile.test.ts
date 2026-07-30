import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalProfileDigest,
  createProfileBinding,
  parseRungSelector,
  preservesBaseline,
  resolveAutomaticRung,
  resolveProfile,
  validateAdmissionProfile,
  validateCapabilityProfile,
  type AdmissionProfile,
  type ProfileBinding,
  type ProfileRequestIdentity,
  type ReasoningCapabilityProfile,
  type RungSelector,
} from "../../src/domain/profile.js";

const CATALOG_DIGEST = "a".repeat(64);
const ADAPTER_DIGEST = "b".repeat(64);
const APPROVAL_DIGEST = "c".repeat(64);

const capability: ReasoningCapabilityProfile = {
  schemaVersion: 1,
  profileId: "synthetic-capability",
  profileRevision: "capability-r1",
  source: { kind: "repository-pinned", repositoryRevision: "synthetic-repository-revision" },
  match: {
    provider: "synthetic-provider",
    api: "synthetic-api",
    model: "synthetic-model",
    modelCatalogRevision: "catalog-r1",
    modelCatalogDigest: CATALOG_DIGEST,
    piVersion: "0.82.1",
    providerAdapterRevision: "adapter-r1",
    providerAdapterDigest: ADAPTER_DIGEST,
  },
  rungs: [
    { id: "r0", ordinal: 0, providerValue: "wire-a", automaticEligible: true, explicitOnly: false },
    { id: "r1", ordinal: 1, providerValue: { mode: "wire-b" }, automaticEligible: true, explicitOnly: false },
    { id: "r2", ordinal: 2, providerValue: ["wire-c", 3], automaticEligible: true, explicitOnly: false },
    { id: "r3", ordinal: 3, providerValue: "wire-explicit", automaticEligible: false, explicitOnly: true },
  ],
  automaticFloor: "r0",
  automaticCeiling: "r2",
  explicitCeiling: "r3",
  anchors: { economical: "r0", balanced: "r1", deliberate: "r2", exhaustive: "r2" },
  baselineBehavior: "preserve-request",
};

const admission: AdmissionProfile = {
  schemaVersion: 1,
  profileId: "synthetic-admission",
  profileRevision: "admission-r1",
  source: { kind: "user-approved-local", approvalDigest: APPROVAL_DIGEST },
  capabilityProfileId: capability.profileId,
  capabilityProfileRevision: capability.profileRevision,
  initial: {
    simpleQuery: { kind: "lowest-automatic" },
    boundedRead: { kind: "lowest-automatic" },
    implementation: { kind: "anchor", name: "balanced" },
    debugging: { kind: "anchor", name: "deliberate" },
    architecture: { kind: "automatic-ceiling" },
    highRisk: { kind: "automatic-ceiling" },
    continuation: { kind: "next-below-ceiling" },
    unknown: { kind: "automatic-ceiling" },
  },
  evidence: {
    firstToolError: { selector: { kind: "next-above-lowest" } },
    repeatedToolError: { selector: { kind: "automatic-ceiling" } },
    providerError: { selector: { kind: "automatic-ceiling" } },
    lengthExhaustion: { selector: { kind: "automatic-ceiling" } },
    overflowRetry: { selector: { kind: "automatic-ceiling" } },
    failedContinuation: { selector: { kind: "automatic-ceiling" } },
  },
};

function bindingFor(
  capabilityValue: unknown = capability,
  admissionValue: unknown = admission,
): ProfileBinding {
  const result = createProfileBinding(capabilityValue, admissionValue);
  if (!result.ok) throw new Error(`synthetic fixture did not bind: ${result.reason}`);
  return result.binding;
}

function identityFor(
  capabilityValue: ReasoningCapabilityProfile = capability,
  admissionValue: AdmissionProfile = admission,
): ProfileRequestIdentity {
  return { match: capabilityValue.match, profileBinding: bindingFor(capabilityValue, admissionValue) };
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function allSelectors(selector: RungSelector): AdmissionProfile["initial"] {
  return {
    simpleQuery: selector,
    boundedRead: selector,
    implementation: selector,
    debugging: selector,
    architecture: selector,
    highRisk: selector,
    continuation: selector,
    unknown: selector,
  };
}

describe("closed canonical profile data", () => {
  it("parses the exhaustive shared selector union and rejects unknown shapes", () => {
    const selectors: readonly RungSelector[] = [
      { kind: "lowest-automatic" },
      { kind: "next-above-lowest" },
      { kind: "next-below-ceiling" },
      { kind: "automatic-ceiling" },
      { kind: "anchor", name: "balanced" },
    ];
    for (const selector of selectors) expect(parseRungSelector(selector)).toEqual(selector);
    expect(parseRungSelector({ kind: "next-above-lowest", name: "balanced" })).toBeUndefined();
    expect(parseRungSelector({ kind: "unknown" })).toBeUndefined();
  });

  it("canonicalizes valid data deterministically without key-order dependence", () => {
    expect(canonicalJson({ b: [2, { d: true, c: null }], a: 1 })).toEqual({
      ok: true,
      canonical: '{"a":1,"b":[2,{"c":null,"d":true}]}',
    });
    const left = canonicalProfileDigest({ b: 2, a: 1 });
    const right = canonicalProfileDigest({ a: 1, b: 2 });
    expect(left).toEqual(right);
    expect(left.ok && left.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["undefined", undefined],
    ["bigint", 1n],
    ["function", () => undefined],
    ["symbol", Symbol("synthetic")],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["negative zero", -0],
    ["unsupported prototype", new Date(0)],
    ["null prototype", Object.create(null)],
  ])("returns a typed failure for %s", (_name, value) => {
    expect(() => canonicalJson(value)).not.toThrow();
    expect(canonicalJson(value).ok).toBe(false);
    expect(canonicalProfileDigest(value).ok).toBe(false);
  });

  it("rejects cycles, sparse arrays, symbols, accessors, and hidden properties", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const sparse = Array.from({ length: 2 });
    delete sparse[0];
    const symbolProperty = { safe: true, [Symbol("hidden")]: true };
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
    const hidden = Object.defineProperty({}, "value", { enumerable: false, value: 1 });
    for (const value of [cycle, sparse, symbolProperty, accessor, hidden]) {
      expect(() => canonicalJson(value)).not.toThrow();
      expect(canonicalJson(value).ok).toBe(false);
    }
  });

  it("rejects coercion cases instead of producing colliding canonical content", () => {
    expect(canonicalJson({})).toEqual({ ok: true, canonical: "{}" });
    expect(canonicalJson({ omitted: undefined }).ok).toBe(false);
    expect(canonicalJson(0)).toEqual({ ok: true, canonical: "0" });
    expect(canonicalJson(-0).ok).toBe(false);
    expect(canonicalJson({ value: 1 })).not.toEqual(canonicalJson({ value: "1" }));
  });
});

describe("profile identity and provenance", () => {
  it("binds exact capability and admission identity, revision, content, and runtime match", () => {
    const result = resolveProfile(identityFor(), capability, admission);
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("expected resolved synthetic fixture");
    expect(result.binding.capability).toMatchObject({
      profileId: capability.profileId,
      profileRevision: capability.profileRevision,
    });
    expect(result.binding.admission).toMatchObject({
      profileId: admission.profileId,
      profileRevision: admission.profileRevision,
    });
    expect(result.binding.capability.profileDigest).not.toBe(result.binding.admission.profileDigest);
    expect(result.binding.match).toEqual(capability.match);
  });

  it("accepts only closed profile provenance variants", () => {
    const candidate = copy(capability) as Mutable<ReasoningCapabilityProfile>;
    candidate.source = {
      kind: "validated-catalog-candidate",
      authority: "candidate-only",
      evidenceDigest: "d".repeat(64),
    };
    expect(validateCapabilityProfile(candidate)).toBe(true);
    const candidateAdmission = copy(admission) as Mutable<AdmissionProfile>;
    candidateAdmission.capabilityProfileId = candidate.profileId;
    candidateAdmission.capabilityProfileRevision = candidate.profileRevision;
    const candidateResolution = resolveProfile(
      identityFor(candidate, candidateAdmission),
      candidate,
      candidateAdmission,
    );
    expect(candidateResolution.status).toBe("unapproved-profile-source");
    const syntheticResolution = resolveProfile(identityFor(), { ...capability, source: { kind: "synthetic-candidate", authority: "candidate-only", fixtureId: "synthetic-fixture" } }, { ...admission, source: { kind: "synthetic-candidate", authority: "candidate-only", fixtureId: "synthetic-fixture" } });
    expect(syntheticResolution.status).toBe("unapproved-profile-source");
    expect(preservesBaseline(candidateResolution)).toBe(true);
    for (const source of [
      { kind: "repository-pinned" },
      { kind: "user-approved-local", approvalDigest: "not-a-digest" },
      { kind: "validated-catalog-candidate", authority: "unsupported-authority", evidenceDigest: "d".repeat(64) },
      { kind: "unknown-source", value: "synthetic" },
    ]) {
      expect(validateCapabilityProfile({ ...capability, source })).toBe(false);
    }
  });

  it("detects distinct admission content under the same ID and revision", () => {
    const changedAdmission = copy(admission) as Mutable<AdmissionProfile>;
    changedAdmission.initial.implementation = { kind: "automatic-ceiling" };
    const originalBinding = identityFor();
    const changedBinding = bindingFor(capability, changedAdmission);
    expect(changedBinding.admission.profileId).toBe(originalBinding.profileBinding.admission.profileId);
    expect(changedBinding.admission.profileRevision).toBe(originalBinding.profileBinding.admission.profileRevision);
    expect(changedBinding.admission.profileDigest).not.toBe(originalBinding.profileBinding.admission.profileDigest);
    const resolution = resolveProfile(originalBinding, capability, changedAdmission);
    expect(resolution.status).toBe("profile-revision-mismatch");
    expect(preservesBaseline(resolution)).toBe(true);
  });

  it.each([
    ["capability ID", (binding: Mutable<ProfileBinding>) => { binding.capability.profileId = "other-capability"; }],
    ["capability revision", (binding: Mutable<ProfileBinding>) => { binding.capability.profileRevision = "other-revision"; }],
    ["capability digest", (binding: Mutable<ProfileBinding>) => { binding.capability.profileDigest = "0".repeat(64); }],
    ["admission ID", (binding: Mutable<ProfileBinding>) => { binding.admission.profileId = "other-admission"; }],
    ["admission revision", (binding: Mutable<ProfileBinding>) => { binding.admission.profileRevision = "other-revision"; }],
    ["admission digest", (binding: Mutable<ProfileBinding>) => { binding.admission.profileDigest = "0".repeat(64); }],
  ])("fails closed for a mismatched %s", (_name, mutate) => {
    const identity = copy(identityFor()) as Mutable<ProfileRequestIdentity>;
    mutate(identity.profileBinding as Mutable<ProfileBinding>);
    const resolution = resolveProfile(identity, capability, admission);
    expect(resolution.status).toBe("profile-revision-mismatch");
    expect(preservesBaseline(resolution)).toBe(true);
  });

  it.each([
    "provider",
    "model",
    "modelCatalogRevision",
    "modelCatalogDigest",
    "piVersion",
    "providerAdapterRevision",
    "providerAdapterDigest",
  ] as const)("requires exact %s match", (key) => {
    const identity = copy(identityFor()) as Mutable<ProfileRequestIdentity>;
    (identity.match as Mutable<typeof identity.match>)[key] = key.endsWith("Digest")
      ? "e".repeat(64)
      : `other-${key}`;
    const resolution = resolveProfile(identity, capability, admission);
    expect(resolution.status).toBe("unknown-model");
    expect(preservesBaseline(resolution)).toBe(true);
  });

  it("distinguishes unsupported API from other unknown runtime identity", () => {
    const identity = copy(identityFor()) as Mutable<ProfileRequestIdentity>;
    identity.match.api = "other-api";
    expect(resolveProfile(identity, capability, admission).status).toBe("unsupported-api");
  });

  it.each([
    "provider",
    "api",
    "model",
    "modelCatalogRevision",
    "modelCatalogDigest",
    "piVersion",
    "providerAdapterRevision",
    "providerAdapterDigest",
  ] as const)("requires exact binding-side %s", (key) => {
    const identity = copy(identityFor());
    (identity.profileBinding.match as Mutable<typeof identity.profileBinding.match>)[key] = key.endsWith("Digest")
      ? "e".repeat(64)
      : `other-${key}`;
    expect(resolveProfile(identity, capability, admission).status).toBe("profile-revision-mismatch");
  });
});

describe("total fail-closed resolution", () => {
  it.each([
    null,
    {},
    { match: capability.match },
    { match: capability.match, profileBinding: bindingFor(), extra: true },
    { match: { ...capability.match, modelCatalogDigest: "bad" }, profileBinding: bindingFor() },
  ])("preserves baseline for malformed identity %#", (identity) => {
    const resolution = resolveProfile(identity, capability, admission);
    expect(resolution.status).not.toBe("resolved");
    expect(preservesBaseline(resolution)).toBe(true);
  });

  it("never throws for hostile inspection boundaries", () => {
    const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error("synthetic trap"); } });
    expect(() => resolveProfile(hostile, capability, admission)).not.toThrow();
    expect(resolveProfile(hostile, capability, admission).status).toBe("invalid-provider-metadata");
    expect(() => resolveProfile(identityFor(), hostile, admission)).not.toThrow();
    expect(resolveProfile(identityFor(), hostile, admission).status).toBe("invalid-capability-profile");
    expect(() => resolveProfile(identityFor(), capability, hostile)).not.toThrow();
    expect(resolveProfile(identityFor(), capability, hostile).status).toBe("invalid-admission-profile");
    expect(() => resolveAutomaticRung(capability, admission, hostile)).not.toThrow();
    expect(resolveAutomaticRung(capability, admission, hostile)).toBeUndefined();
  });

  it("returns explicit unresolved statuses for malformed binding and profile content", () => {
    const malformedBinding = { ...identityFor(), profileBinding: { capability: {}, admission: {}, match: {} } };
    expect(resolveProfile(malformedBinding, capability, admission).status).toBe("invalid-profile-binding");
    const malformedDigest = copy(identityFor()) as Mutable<ProfileRequestIdentity>;
    malformedDigest.profileBinding.admission.profileDigest = "not-a-digest";
    expect(resolveProfile(malformedDigest, capability, admission).status).toBe("invalid-profile-binding");
    expect(resolveProfile(identityFor(), { ...capability, profileId: "" }, admission).status).toBe("invalid-capability-profile");
    expect(resolveProfile(identityFor(), capability, { ...admission, profileId: "" }).status).toBe("invalid-admission-profile");
  });

  it("rejects cyclic provider data without throwing into resolution", () => {
    const cyclicCapability = copy(capability) as ReasoningCapabilityProfile & {
      rungs: Array<ReasoningCapabilityProfile["rungs"][number]>;
    };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    cyclicCapability.rungs[0] = { ...cyclicCapability.rungs[0]!, providerValue: cycle as never };
    expect(() => resolveProfile(identityFor(), cyclicCapability, admission)).not.toThrow();
    expect(resolveProfile(identityFor(), cyclicCapability, admission).status).toBe("invalid-capability-profile");
  });
});

describe("structural profile semantics", () => {
  it.each([
    ["balanced below economical", { economical: "r1", balanced: "r0", deliberate: "r2", exhaustive: "r2" }],
    ["deliberate below balanced", { economical: "r0", balanced: "r2", deliberate: "r1", exhaustive: "r2" }],
    ["exhaustive below deliberate", { economical: "r0", balanced: "r1", deliberate: "r2", exhaustive: "r1" }],
  ])("rejects anchor order mutation: %s", (_name, anchors) => {
    expect(validateCapabilityProfile({ ...copy(capability), anchors })).toBe(false);
  });
  it("permits equal adjacent anchors", () => {
    expect(validateCapabilityProfile({ ...copy(capability), anchors: { economical: "r0", balanced: "r0", deliberate: "r1", exhaustive: "r1" } })).toBe(true);
  });
  it.each([
    ["missing anchor", () => {
      const changed = copy(capability) as Mutable<ReasoningCapabilityProfile>;
      delete (changed.anchors as Partial<typeof changed.anchors>).balanced;
      return changed;
    }],
    ["extra anchor", () => {
      const changed = copy(capability) as Mutable<ReasoningCapabilityProfile>;
      Object.assign(changed.anchors, { speculative: "r1" });
      return changed;
    }],
    ["explicit-only anchor", () => ({ ...copy(capability), anchors: { ...capability.anchors, exhaustive: "r3" } })],
    ["out-of-order rungs", () => ({ ...copy(capability), rungs: [capability.rungs[1], capability.rungs[0], ...capability.rungs.slice(2)] })],
    ["duplicate ordinal", () => {
      const changed = copy(capability) as Mutable<ReasoningCapabilityProfile>;
      changed.rungs[1]!.ordinal = changed.rungs[0]!.ordinal;
      return changed;
    }],
  ])("rejects capability with %s", (_name, makeProfile) => {
    expect(validateCapabilityProfile(makeProfile())).toBe(false);
  });

  it.each([
    ["missing explicit ceiling", () => {
      const changed = copy(capability) as Mutable<Partial<ReasoningCapabilityProfile>>;
      delete changed.explicitCeiling;
      return changed;
    }],
    ["undefined supplied explicit ceiling", () => ({ ...copy(capability), explicitCeiling: undefined })],
    ["unknown supplied explicit ceiling", () => ({ ...copy(capability), explicitCeiling: "missing-rung" })],
    ["automatic explicit ceiling", () => ({ ...copy(capability), explicitCeiling: "r2" })],
    ["explicit ceiling below automatic ceiling", () => {
      const changed = copy(capability) as Mutable<ReasoningCapabilityProfile>;
      changed.rungs = [
        { id: "r-explicit", ordinal: 0, providerValue: "wire-explicit", automaticEligible: false, explicitOnly: true },
        { id: "r-auto", ordinal: 1, providerValue: "wire-auto", automaticEligible: true, explicitOnly: false },
      ];
      changed.automaticFloor = "r-auto";
      changed.automaticCeiling = "r-auto";
      changed.explicitCeiling = "r-explicit";
      changed.anchors = { economical: "r-auto", balanced: "r-auto", deliberate: "r-auto", exhaustive: "r-auto" };
      return changed;
    }],
  ])("rejects %s", (_name, makeProfile) => {
    expect(validateCapabilityProfile(makeProfile())).toBe(false);
  });

  it.each([
    ["empty initial map", () => ({ ...admission, initial: {} })],
    ["extra initial key", () => ({ ...admission, initial: { ...admission.initial, speculative: { kind: "automatic-ceiling" } } })],
    ["missing initial key", () => {
      const changed = copy(admission) as Mutable<AdmissionProfile>;
      delete (changed.initial as Partial<typeof changed.initial>).unknown;
      return changed;
    }],
    ["empty evidence map", () => ({ ...admission, evidence: {} })],
    ["missing evidence key", () => {
      const changed = copy(admission) as Mutable<AdmissionProfile>;
      delete (changed.evidence as Partial<typeof changed.evidence>).providerError;
      return changed;
    }],
    ["extra evidence key", () => ({ ...admission, evidence: { ...admission.evidence, speculative: { selector: { kind: "automatic-ceiling" } } } })],
    ["unknown selector", () => ({ ...admission, initial: { ...admission.initial, unknown: { kind: "synthetic-unknown" } } })],
    ["selector with extra data", () => ({ ...admission, initial: { ...admission.initial, unknown: { kind: "automatic-ceiling", value: 1 } } })],
    ["unknown anchor", () => ({ ...admission, initial: { ...admission.initial, unknown: { kind: "anchor", name: "synthetic-anchor" } } })],
    ["empty evidence rule", () => ({ ...admission, evidence: { ...admission.evidence, providerError: {} } })],
  ])("rejects admission with %s", (_name, makeProfile) => {
    expect(validateAdmissionProfile(makeProfile(), capability)).toBe(false);
  });

  it("supports two automatic rungs with no explicit-only rung or explicit ceiling", () => {
    const minimalCapability = copy(capability) as Mutable<ReasoningCapabilityProfile>;
    minimalCapability.profileId = "synthetic-minimal-capability";
    minimalCapability.rungs = [
      { id: "economy", ordinal: 10, providerValue: "wire-economy", automaticEligible: true, explicitOnly: false },
      { id: "depth", ordinal: 20, providerValue: "wire-depth", automaticEligible: true, explicitOnly: false },
    ];
    minimalCapability.automaticFloor = "economy";
    minimalCapability.automaticCeiling = "depth";
    delete minimalCapability.explicitCeiling;
    minimalCapability.anchors = {
      economical: "economy",
      balanced: "economy",
      deliberate: "depth",
      exhaustive: "depth",
    };
    const minimalAdmission: AdmissionProfile = {
      ...copy(admission),
      profileId: "synthetic-minimal-admission",
      capabilityProfileId: minimalCapability.profileId,
      capabilityProfileRevision: minimalCapability.profileRevision,
      initial: allSelectors({ kind: "automatic-ceiling" }),
      evidence: Object.fromEntries(
        Object.keys(admission.evidence).map((key) => [key, { selector: { kind: "automatic-ceiling" } }]),
      ) as AdmissionProfile["evidence"],
    };
    expect(validateCapabilityProfile(minimalCapability)).toBe(true);
    expect(validateAdmissionProfile(minimalAdmission, minimalCapability)).toBe(true);
    expect(createProfileBinding(minimalCapability, minimalAdmission).ok).toBe(true);
    expect(resolveProfile(identityFor(minimalCapability, minimalAdmission), minimalCapability, minimalAdmission).status).toBe("resolved");
    expect(resolveAutomaticRung(minimalCapability, minimalAdmission, { kind: "anchor", name: "exhaustive" })).toMatchObject({
      rungId: "depth",
      ordinal: 20,
    });
  });

  it("supports a five-rung profile with a supplied explicit-only ceiling", () => {
    const fiveRungCapability: ReasoningCapabilityProfile = {
      ...copy(capability),
      profileId: "synthetic-five-rung-capability",
      rungs: [
        { id: "a0", ordinal: 0, providerValue: "wire-a0", automaticEligible: true, explicitOnly: false },
        { id: "a1", ordinal: 1, providerValue: "wire-a1", automaticEligible: true, explicitOnly: false },
        { id: "a2", ordinal: 2, providerValue: "wire-a2", automaticEligible: true, explicitOnly: false },
        { id: "a3", ordinal: 3, providerValue: "wire-a3", automaticEligible: true, explicitOnly: false },
        { id: "e4", ordinal: 4, providerValue: "wire-e4", automaticEligible: false, explicitOnly: true },
      ],
      automaticFloor: "a0",
      automaticCeiling: "a3",
      explicitCeiling: "e4",
      anchors: { economical: "a0", balanced: "a1", deliberate: "a2", exhaustive: "a3" },
    };
    const fiveRungAdmission: AdmissionProfile = {
      ...copy(admission),
      profileId: "synthetic-five-rung-admission",
      capabilityProfileId: fiveRungCapability.profileId,
      capabilityProfileRevision: fiveRungCapability.profileRevision,
    };
    expect(validateCapabilityProfile(fiveRungCapability)).toBe(true);
    expect(validateAdmissionProfile(fiveRungAdmission, fiveRungCapability)).toBe(true);
    expect(resolveProfile(identityFor(fiveRungCapability, fiveRungAdmission), fiveRungCapability, fiveRungAdmission).status).toBe("resolved");
    expect(resolveAutomaticRung(fiveRungCapability, fiveRungAdmission, { kind: "automatic-ceiling" })).toMatchObject({
      rungId: "a3",
      ordinal: 3,
    });
  });

  it("rejects infeasible positional selectors at the minimal boundary", () => {
    const minimalCapability = {
      ...copy(capability),
      rungs: [
        { id: "automatic", ordinal: 0, providerValue: "wire-automatic", automaticEligible: true, explicitOnly: false },
        { id: "explicit", ordinal: 1, providerValue: "wire-explicit", automaticEligible: false, explicitOnly: true },
      ],
      automaticFloor: "automatic",
      automaticCeiling: "automatic",
      explicitCeiling: "explicit",
      anchors: { economical: "automatic", balanced: "automatic", deliberate: "automatic", exhaustive: "automatic" },
    };
    const infeasible = {
      ...copy(admission),
      capabilityProfileId: minimalCapability.profileId,
      capabilityProfileRevision: minimalCapability.profileRevision,
      initial: allSelectors({ kind: "next-above-lowest" }),
    };
    expect(validateAdmissionProfile(infeasible, minimalCapability)).toBe(false);
    expect(resolveAutomaticRung(minimalCapability, infeasible, { kind: "next-above-lowest" })).toBeUndefined();
  });

  it("never selects the explicit ceiling automatically", () => {
    for (const selector of [
      { kind: "automatic-ceiling" },
      { kind: "anchor", name: "exhaustive" },
      { kind: "next-above-lowest" },
      { kind: "next-below-ceiling" },
    ] as const) {
      expect(resolveAutomaticRung(capability, admission, selector)?.rungId).not.toBe(capability.explicitCeiling);
    }
  });
});

type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key] extends object ? Mutable<T[Key]> : T[Key];
};
