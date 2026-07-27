import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalPayloadHash,
  patchProviderPayload,
  patchProviderPayloadOutcome,
  supportsEffortRouting,
  withoutReasoningEffort,
  type ProviderPatchInput,
} from "../../src/provider/patch.js";
import {
  createProfileBinding,
  createProfileActivationSnapshot,
  type AdmissionProfile,
  type ProfileRequestIdentity,
  type ReasoningCapabilityProfile,
  type ResolvedRung,
} from "../../src/domain/profile.js";

const CATALOG_DIGEST = "a".repeat(64);
const ADAPTER_DIGEST = "b".repeat(64);
const APPROVAL_DIGEST = "c".repeat(64);

const fixture = async (relativePath: string): Promise<unknown> => JSON.parse(await readFile(
  fileURLToPath(new URL(`../fixtures/${relativePath}`, import.meta.url)), "utf8"),
) as unknown;

function profile(api: "openai-codex-responses" | "openai-responses"): ReasoningCapabilityProfile {
  return {
    schemaVersion: 1,
    profileId: `synthetic-${api}-capability`,
    profileRevision: "capability-r1",
    source: { kind: "repository-pinned", repositoryRevision: "synthetic-repository-revision" },
    match: {
      provider: "synthetic-openai-provider",
      api,
      model: api === "openai-codex-responses" ? "gpt-5.6-codex" : "gpt-5.6",
      modelCatalogRevision: "catalog-r1",
      modelCatalogDigest: CATALOG_DIGEST,
      piVersion: "0.82.1",
      providerAdapterRevision: "adapter-r1",
      providerAdapterDigest: ADAPTER_DIGEST,
    },
    rungs: [
      { id: "economy", ordinal: 0, providerValue: "low", automaticEligible: true, explicitOnly: false },
      { id: "depth", ordinal: 1, providerValue: "high", automaticEligible: true, explicitOnly: false },
      { id: "explicit", ordinal: 2, providerValue: "xhigh", automaticEligible: false, explicitOnly: true },
    ],
    automaticFloor: "economy",
    automaticCeiling: "depth",
    explicitCeiling: "explicit",
    anchors: { economical: "economy", balanced: "depth", deliberate: "depth", exhaustive: "depth" },
    baselineBehavior: "preserve-request",
  };
}

function admission(capability: ReasoningCapabilityProfile): AdmissionProfile {
  const selector = { kind: "automatic-ceiling" } as const;
  return {
    schemaVersion: 1,
    profileId: "synthetic-admission",
    profileRevision: "admission-r1",
    source: { kind: "user-approved-local", approvalDigest: APPROVAL_DIGEST },
    capabilityProfileId: capability.profileId,
    capabilityProfileRevision: capability.profileRevision,
    initial: {
      simpleQuery: selector, boundedRead: selector, implementation: selector, debugging: selector,
      architecture: selector, highRisk: selector, continuation: selector, unknown: selector,
    },
    evidence: {
      firstToolError: { selector }, repeatedToolError: { selector }, providerError: { selector },
      lengthExhaustion: { selector }, overflowRetry: { selector }, failedContinuation: { selector },
    },
  };
}

function inputFor(api: "openai-codex-responses" | "openai-responses", rungId = "economy"): ProviderPatchInput {
  const capability = profile(api);
  const admissionProfile = admission(capability);
  const binding = createProfileBinding(capability, admissionProfile);
  if (!binding.ok) throw new Error(`invalid synthetic profile: ${binding.reason}`);
  const rung = capability.rungs.find((value) => value.id === rungId)!;
  const identity: ProfileRequestIdentity = { match: capability.match, profileBinding: binding.binding };
  const resolvedRung: ResolvedRung = { binding: binding.binding, rungId: rung.id, ordinal: rung.ordinal };
  return { identity, capabilityProfile: capability, admissionProfile, resolvedRung };
}

function boundInputFor(api: "openai-codex-responses" | "openai-responses"): ProviderPatchInput {
  const capability = profile(api); const admissionProfile = admission(capability);
  const snapshot = createProfileActivationSnapshot(capability, admissionProfile);
  if (snapshot.status !== "ready") throw new Error("synthetic bound profile should prepare");
  const boundSelection = snapshot.routing.provider.economy;
  if (!boundSelection) throw new Error("synthetic provider value should bind");
  return { boundSelection };
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

describe("profile-aware provider patch layer", () => {
  it("recognizes exactly the two v1 Responses APIs", () => {
    expect(supportsEffortRouting("openai-codex-responses")).toBe(true);
    expect(supportsEffortRouting("openai-responses")).toBe(true);
    expect(supportsEffortRouting("azure-openai-responses")).toBe(false);
    expect(supportsEffortRouting(undefined)).toBe(false);
  });

  it.each([
    "openai-codex-responses/first-turn.json", "openai-codex-responses/tool-continuation.json",
    "openai-codex-responses/reasoning-replay.json", "openai-codex-responses/compacted-session.json",
    "openai-responses/first-turn.json", "openai-responses/tool-continuation.json",
    "openai-responses/reasoning-replay.json",
  ])("preserves every fixture field except reasoning.effort: %s", async (path) => {
    const original = await fixture(path);
    const api = path.startsWith("openai-codex") ? "openai-codex-responses" : "openai-responses";
    const patched = patchProviderPayload(inputFor(api), original);
    expect(withoutReasoningEffort(patched)).toStrictEqual(withoutReasoningEffort(original));
    expect(canonicalPayloadHash(withoutReasoningEffort(patched))).toEqual(canonicalPayloadHash(withoutReasoningEffort(original)));
    expect((patched as { reasoning: { effort: string } }).reasoning.effort).toBe("low");
  });

  it("requires an exact supported profile binding and preserves mismatches by reference", () => {
    const original = { reasoning: { effort: "medium", context: "synthetic-context" }, prompt_cache_key: "synthetic-cache" };
    const valid = inputFor("openai-responses");
    const mismatch: ProviderPatchInput = {
      ...valid,
      identity: { ...valid.identity as ProfileRequestIdentity, match: { ...(valid.identity as ProfileRequestIdentity).match, providerAdapterDigest: "d".repeat(64) } },
    };
    expect(patchProviderPayload(mismatch, original)).toBe(original);
    const validRung = valid.resolvedRung as ResolvedRung;
    const wrongRung: ProviderPatchInput = {
      ...valid,
      resolvedRung: { ...validRung, binding: { ...validRung.binding, admission: { ...validRung.binding.admission, profileDigest: "e".repeat(64) } } },
    };
    expect(patchProviderPayload(wrongRung, original)).toBe(original);
    const supported = inputFor("openai-responses");
    const supportedIdentity = supported.identity as ProfileRequestIdentity;
    const unsupported: ProviderPatchInput = {
      ...supported,
      identity: { ...supportedIdentity, match: { ...supportedIdentity.match, api: "synthetic-api" } },
    };
    expect(patchProviderPayload(unsupported, original)).toBe(original);
  });

  it("adds only reasoning.effort when reasoning is absent and retains nested references", () => {
    const valid = inputFor("openai-codex-responses");
    const nested = { cache: "synthetic" };
    const original = { input: [nested], prompt_cache_options: nested };
    const patched = patchProviderPayload(valid, original) as typeof original & { reasoning: { effort: string } };
    expect(patched).not.toBe(original);
    expect(patched.reasoning).toEqual({ effort: "low" });
    expect(patched.input).toBe(original.input);
    expect(patched.prompt_cache_options).toBe(original.prompt_cache_options);
    const { reasoning: _reasoning, ...preserved } = patched;
    expect(preserved).toEqual(original);
  });

  it("leaves malformed, conflicted, and non-encodable payloads unchanged by reference", () => {
    const valid = inputFor("openai-codex-responses");
    for (const payload of [undefined, null, [], "request", { reasoning: null }, { reasoning: { effort: 4 } }]) {
      expect(patchProviderPayload(valid, payload)).toBe(payload);
    }
    const original = { reasoning: { effort: "medium" } };
    expect(patchProviderPayload(undefined as never, original)).toBe(original);
    const candidateCapability: ReasoningCapabilityProfile = {
      ...profile("openai-codex-responses"),
      source: { kind: "validated-catalog-candidate", authority: "candidate-only", evidenceDigest: "d".repeat(64) },
    };
    const candidateAdmission = admission(candidateCapability);
    const candidateBinding = createProfileBinding(candidateCapability, candidateAdmission);
    if (!candidateBinding.ok) throw new Error(`invalid synthetic profile: ${candidateBinding.reason}`);
    expect(patchProviderPayload({
      identity: { match: candidateCapability.match, profileBinding: candidateBinding.binding },
      capabilityProfile: candidateCapability,
      admissionProfile: candidateAdmission,
      resolvedRung: { binding: candidateBinding.binding, rungId: "economy", ordinal: 0 },
    }, original)).toBe(original);
  });

  it("encodes an exact-bound explicit-only rung without adapter policy selection", () => {
    const patched = patchProviderPayload(inputFor("openai-codex-responses", "explicit"), {
      reasoning: { effort: "medium", context: "synthetic" },
    });
    expect((patched as { reasoning: { effort: string } }).reasoning.effort).toBe("xhigh");
  });

  it("rejects an unissued bound-selection lookalike without falling back to legacy fields", () => {
    const legacy = inputFor("openai-responses");
    const original = { reasoning: { effort: "medium" } };
    expect(patchProviderPayload({ ...legacy, boundSelection: { api: "openai-responses", effort: "low" } }, original)).toBe(original);
  });

  it("reports truthful structured outcomes and preserves every non-applied payload by reference", () => {
    const appliedPayload = { reasoning: { effort: "medium" }, cache: "synthetic" };
    const applied = patchProviderPayloadOutcome(boundInputFor("openai-responses"), appliedPayload);
    expect(applied).toMatchObject({ status: "applied", appliedEffort: "low" }); expect(applied.payload).not.toBe(appliedPayload);
    const unsupportedPayload = { reasoning: { effort: "medium" } };
    const invalidPayload = new Date(0);
    const mappingPayload = { reasoning: { effort: 4 } };
    const conflicting = inputFor("openai-responses");
    const conflictingIdentity = conflicting.identity as ProfileRequestIdentity;
    const conflictPayload = { reasoning: { effort: "medium" } };
    const cases = [
      ["unsupported", patchProviderPayloadOutcome(undefined, unsupportedPayload), unsupportedPayload],
      ["invalid_payload", patchProviderPayloadOutcome(boundInputFor("openai-responses"), invalidPayload), invalidPayload],
      ["mapping_failed", patchProviderPayloadOutcome(boundInputFor("openai-responses"), mappingPayload), mappingPayload],
      ["profile conflict", patchProviderPayloadOutcome({ ...conflicting, identity: { ...conflictingIdentity, match: { ...conflictingIdentity.match, modelCatalogDigest: "e".repeat(64) } } }, conflictPayload), conflictPayload],
      ["untrusted bound selection", patchProviderPayloadOutcome({ ...boundInputFor("openai-responses"), boundSelection: { api: "openai-responses", effort: "low" } }, conflictPayload), conflictPayload],
    ] as const;
    for (const [name, outcome, original] of cases) { expect(outcome.payload, name).toBe(original); expect(outcome.status, name).not.toBe("applied"); expect(outcome).not.toHaveProperty("appliedEffort"); }
    expect(cases[0]![1].status).toBe("unsupported"); expect(cases[1]![1].status).toBe("invalid_payload"); expect(cases[2]![1].status).toBe("mapping_failed"); expect(cases[3]![1].status).toBe("unsupported"); expect(cases[4]![1].status).toBe("unsupported");
  });

  it.each(["", { effort: "synthetic" }] as const)("fails closed for non-encodable provider value %#", (providerValue) => {
    const capability: ReasoningCapabilityProfile = {
      ...profile("openai-responses"),
      rungs: profile("openai-responses").rungs.map((rung, index) => index === 0 ? { ...rung, providerValue } : rung),
    };
    const admissionProfile = admission(capability);
    const binding = createProfileBinding(capability, admissionProfile);
    if (!binding.ok) throw new Error(`invalid synthetic profile: ${binding.reason}`);
    const original = { reasoning: { effort: "medium" } };
    expect(patchProviderPayload({
      identity: { match: capability.match, profileBinding: binding.binding }, capabilityProfile: capability, admissionProfile,
      resolvedRung: { binding: binding.binding, rungId: "economy", ordinal: 0 },
    }, original)).toBe(original);
  });

  it("fails closed for hostile payloads without invoking accessors", () => {
    const valid = inputFor("openai-responses");
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "reasoning", {
      enumerable: true,
      get: () => { getterCalls += 1; return { effort: "medium" }; },
    });
    const symbolKey = { reasoning: { effort: "medium" }, [Symbol("synthetic")]: true };
    const hidden = Object.defineProperty({ reasoning: { effort: "medium" } }, "hidden", { value: true });
    const sparse = ["synthetic"];
    sparse.length = 2;
    const cyclic: { reasoning: { effort: string }; self?: unknown } = { reasoning: { effort: "medium" } };
    cyclic.self = cyclic;
    const customPrototype = Object.assign(Object.create({ synthetic: true }), { reasoning: { effort: "medium" } });
    const proxy = new Proxy({ reasoning: { effort: "medium" } }, { getPrototypeOf: () => { throw new Error("synthetic trap"); } });
    for (const payload of [accessor, symbolKey, hidden, sparse, cyclic, customPrototype, proxy, { reasoning: { effort: Number.NaN } }, { nested: undefined }, { nested: 1n }]) {
      expect(() => patchProviderPayload(valid, payload)).not.toThrow();
      expect(patchProviderPayload(valid, payload)).toBe(payload);
    }
    expect(getterCalls).toBe(0);
  });

  it("returns typed canonical failures instead of digest collisions or throws", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const sparse = Array.from({ length: 2 });
    delete sparse[0];
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
    const hidden = Object.defineProperty({}, "value", { enumerable: false, value: 1 });
    const proxy = new Proxy({}, { getPrototypeOf: () => { throw new Error("synthetic trap"); } });
    for (const payload of [undefined, Number.NaN, -0, 1n, () => undefined, Symbol("synthetic"), cycle, sparse, accessor, hidden, { [Symbol("synthetic")]: true }, new Date(0), proxy]) {
      expect(() => canonicalPayloadHash(payload)).not.toThrow();
      expect(canonicalPayloadHash(payload).ok).toBe(false);
    }
  });

  it("preserves provider-owned values without applying a global effort ladder", () => {
    const input = inputFor("openai-responses");
    const originalCapability = input.capabilityProfile as ReasoningCapabilityProfile;
    const capability: ReasoningCapabilityProfile = {
      ...copy(originalCapability),
      rungs: originalCapability.rungs.map((rung, index) => index === 0
        ? { ...rung, providerValue: "provider-owned-wire-value" }
        : rung),
    };
    const admissionProfile = admission(capability);
    const binding = createProfileBinding(capability, admissionProfile);
    if (!binding.ok) throw new Error(`invalid synthetic profile: ${binding.reason}`);
    const patched = patchProviderPayload({
      identity: { match: capability.match, profileBinding: binding.binding }, capabilityProfile: capability, admissionProfile,
      resolvedRung: { binding: binding.binding, rungId: "economy", ordinal: 0 },
    }, { reasoning: { effort: "medium", summary: "auto", context: "synthetic" } });
    expect((patched as { reasoning: { effort: string } }).reasoning.effort).toBe("provider-owned-wire-value");
  });

  it("has a deterministic structural preservation property across JSON-like payloads", () => {
    let seed = 0x5eed1234;
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    for (let index = 0; index < 200; index += 1) {
      const payload = {
        instructions: `synthetic-${next()}`, input: [{ role: "user", content: `synthetic-${next()}` }],
        tools: [{ type: "function", name: `tool_${next()}` }], prompt_cache_key: `cache-${next()}`,
        prompt_cache_options: { retention: "24h", salt: next() }, previous_response_id: `resp-${next()}`,
        reasoning: { effort: "medium", summary: `summary-${next()}`, context: `encrypted-${next()}` }, transport: { retry: next() % 3 },
      };
      const patched = patchProviderPayload(inputFor("openai-codex-responses"), payload);
      expect(withoutReasoningEffort(patched)).toStrictEqual(withoutReasoningEffort(payload));
      expect(canonicalPayloadHash(withoutReasoningEffort(patched))).toEqual(canonicalPayloadHash(withoutReasoningEffort(payload)));
    }
  });

  it("marks every fixture as synthetic and sanitized", async () => {
    for (const path of ["openai-codex-responses/first-turn.json", "openai-codex-responses/tool-continuation.json", "openai-codex-responses/reasoning-replay.json", "openai-codex-responses/compacted-session.json", "openai-responses/first-turn.json", "openai-responses/tool-continuation.json", "openai-responses/reasoning-replay.json"]) {
      const value = await fixture(path) as { fixture_provenance: string };
      expect(value.fixture_provenance).toContain("synthetic sanitized");
      expect(value.fixture_provenance).toContain("not a captured real Pi request");
    }
  });
});
