import { describe, expect, it } from "vitest";
import { createProfileActivationSnapshot, isCommandSafeToken, isTrustedBoundProviderSelection, profilePreparationProbe } from "../../src/domain/profile.js";
import { patchProviderPayload } from "../../src/provider/patch.js";
import { EpochRouter, parseEffortCommand } from "../../src/runtime/router.js";
const match = { provider: "p", api: "openai-responses", model: "m", modelCatalogRevision: "r", modelCatalogDigest: "a".repeat(64), piVersion: "0.82.1", providerAdapterRevision: "r", providerAdapterDigest: "b".repeat(64) };
const capability = { schemaVersion: 1, profileId: "cap", profileRevision: "1", source: { kind: "repository-pinned", repositoryRevision: "r" }, match, rungs: [0, 1, 2, 3].map((ordinal) => ({ id: `r${ordinal}`, ordinal, providerValue: `wire-${ordinal}`, automaticEligible: ordinal < 3, explicitOnly: ordinal === 3, ...(ordinal === 2 ? { aliases: ["careful"] } : {}) })), automaticFloor: "r0", automaticCeiling: "r2", explicitCeiling: "r3", anchors: { economical: "r0", balanced: "r1", deliberate: "r2", exhaustive: "r2" }, baselineBehavior: "preserve-request" } as const;
const admission = { schemaVersion: 1, profileId: "adm", profileRevision: "1", source: { kind: "repository-pinned", repositoryRevision: "r" }, capabilityProfileId: "cap", capabilityProfileRevision: "1", initial: { simpleQuery: { kind: "lowest-automatic" }, boundedRead: { kind: "next-above-lowest" }, implementation: { kind: "anchor", name: "balanced" }, debugging: { kind: "anchor", name: "deliberate" }, architecture: { kind: "automatic-ceiling" }, highRisk: { kind: "automatic-ceiling" }, continuation: { kind: "anchor", name: "balanced" }, unknown: { kind: "automatic-ceiling" } }, evidence: Object.fromEntries(["firstToolError", "repeatedToolError", "providerError", "lengthExhaustion", "overflowRetry", "failedContinuation"].map((key) => [key, { selector: { kind: "automatic-ceiling" } }])) } as const;
const readySnapshot = (capabilityValue: unknown = capability, admissionValue: unknown = admission) => {
  const snapshot = createProfileActivationSnapshot(capabilityValue, admissionValue);
  if (snapshot.status !== "ready") throw new Error("synthetic profile should prepare");
  return snapshot;
};
const router = (capabilityValue: unknown = capability, admissionValue: unknown = admission, identity = match) => {
  const r = new EpochRouter();
  if (!r.activateSnapshot(identity, readySnapshot(capabilityValue, admissionValue))) throw new Error("synthetic snapshot should activate");
  return r;
};
describe("profile-relative epoch router", () => {
  it("decides before the first provider request and allows settled independent reset", () => { const r = router(); expect(r.start({ prompt: "implement feature" })?.selectedRung.rungId).toBe("r1"); r.onToolError(); r.settle(); expect(r.start({ prompt: "What is JSON?" })?.selectedRung.rungId).toBe("r0"); });
  it("keeps generation, epoch floor, and manual preference when a reconciliation has the exact same binding", () => {
    const r = router(); const snapshot = readySnapshot(); r.start({ prompt: "What is JSON?" }); r.onToolError(); expect(parseEffortCommand("/effort r3", r)).toBe(true);
    const generation = r.generation; const epoch = r.runtime.currentEpoch; const effective = r.effectiveRung();
    expect(r.activateSnapshot(match, snapshot)).toBe(true); expect(r.generation).toBe(generation); expect(r.runtime.currentEpoch).toBe(epoch); expect(r.effectiveRung()).toBe(effective); expect(r.runtime.manualOverride?.rung.rungId).toBe("r3");
  });
  it("retains compiled selector provenance when distinct selectors resolve to one rung", () => {
    const sameRung = { ...admission, initial: { ...admission.initial, implementation: { kind: "anchor", name: "balanced" }, boundedRead: { kind: "next-above-lowest" } } } as const;
    const implementation = router(capability, sameRung).start({ prompt: "implement feature" })!;
    const bounded = router(capability, sameRung).start({ prompt: "inspect this" })!;
    expect(implementation.selectedRung.rungId).toBe(bounded.selectedRung.rungId);
    expect(implementation.selector).toEqual({ kind: "anchor", name: "balanced" });
    expect(bounded.selector).toEqual({ kind: "next-above-lowest" });
    const evidence = { ...admission, evidence: { ...admission.evidence, firstToolError: { selector: { kind: "anchor", name: "balanced" } } } } as const;
    const escalated = router(capability, evidence); escalated.start({ prompt: "What is JSON?" }); escalated.onToolError();
    expect(escalated.observation()?.escalation).toMatchObject({ selector: { kind: "anchor", name: "balanced" }, rung: { rungId: "r1" } });
    expect(parseEffortCommand("/effort r3", escalated)).toBe(true);
    expect(escalated.observation()?.manual).toMatchObject({ rungId: "r3" });
  });
  it("inherits and escalates only within the exact profile binding", () => { const r = router(); r.start({ prompt: "What is JSON?" }); r.onToolError(); expect(r.start({ prompt: "continue" })?.effectiveFloor.rungId).toBe("r2"); });
  it.each([["error"], ["length"]] as const)("escalates %s", (reason) => { const r = router(); r.start({ prompt: "What is JSON?" }); r.onProviderEnd(reason); expect(r.effectiveRung()?.rungId).toBe("r2"); });
  it("uses aliases and explicit ceiling only through a local command; auto preserves the active floor", () => { const r = router(); r.start({ prompt: "What is JSON?" }); expect(parseEffortCommand("/effort careful", r)).toBe(true); expect(r.effectiveRung()?.rungId).toBe("r2"); expect(parseEffortCommand("/effort r3", r)).toBe(true); expect(r.effectiveRung()?.rungId).toBe("r3"); expect(parseEffortCommand("/effort auto", r)).toBe(true); expect(r.effectiveRung()?.rungId).toBe("r3"); });
  it("leaves unresolved activation baseline untouched", () => { expect(new EpochRouter().start({ prompt: "What is JSON?" })).toBeUndefined(); });
  it("preserves queued source and streaming metadata while replacing the raw prompt", () => {
    const r = router();
    r.queueInput({ prompt: "raw?", source: "interactive", streamingBehavior: "followUp" });
    r.replaceQueuedPrompt("expanded question?");
    expect(r.startQueued()?.selectedRung.rungId).toBe("r1");
  });
  it("inherits the actual settled floor for ambiguous work, but lets an independent task reset", () => {
    const r = router();
    r.start({ prompt: "What is JSON?" }); r.onToolError(); r.settle();
    expect(r.start({ prompt: "please handle this" })?.effectiveFloor.rungId).toBe("r2");
    r.settle();
    expect(r.start({ prompt: "new question: what is JSON?" })?.effectiveFloor.rungId).toBe("r0");
  });
  it("treats a failed predecessor as failedContinuation for an ambiguous reference", () => {
    const r = router();
    expect(r.start({ prompt: "implement feature" })?.effectiveFloor.rungId).toBe("r1");
    r.settle(true);
    // No explicit continuation token: this is the production ambiguous path.
    const decision = r.start({ prompt: "that one" })!;
    expect(decision.relation).toBe("ambiguous");
    expect(decision.selectedRung.rungId).toBe("r2");
    expect(decision.reasons).toContain("PREVIOUS_EPOCH_FAILED");
  });
  it("accepts an exact manual choice before the first task and treats repeated valid commands as handled", () => {
    const r = router();
    expect(parseEffortCommand("/effort r3", r)).toBe(true);
    expect(parseEffortCommand("/effort r3", r)).toBe(true);
    expect(r.start({ prompt: "What is JSON?" })?.effectiveFloor.rungId).toBe("r3");
    expect(parseEffortCommand("/effort missing", r)).toBe(false);
  });
  it("applies every profile evidence selector without crossing the automatic ceiling", () => {
    const evidence = {
      firstToolError: { selector: { kind: "next-above-lowest" } },
      repeatedToolError: { selector: { kind: "anchor", name: "deliberate" } },
      providerError: { selector: { kind: "next-below-ceiling" } },
      lengthExhaustion: { selector: { kind: "automatic-ceiling" } },
      overflowRetry: { selector: { kind: "anchor", name: "balanced" } },
      failedContinuation: { selector: { kind: "automatic-ceiling" } },
    } as const;
    const make = () => router(capability, { ...admission, evidence });
    const first = make(); first.start({ prompt: "What is JSON?" }); first.onToolError(); expect(first.effectiveRung()?.rungId).toBe("r1"); first.onToolError(); expect(first.effectiveRung()?.rungId).toBe("r2");
    const provider = make(); provider.start({ prompt: "What is JSON?" }); provider.onProviderEnd("error"); expect(provider.effectiveRung()?.rungId).toBe("r1"); provider.onProviderEnd("length"); expect(provider.effectiveRung()?.rungId).toBe("r2");
    const overflow = make(); overflow.start({ prompt: "What is JSON?" }); overflow.onCompaction("overflow", true); expect(overflow.effectiveRung()?.rungId).toBe("r1");
    const failed = make(); failed.start({ prompt: "What is JSON?" }); failed.settle(true); expect(failed.start({ prompt: "continue" })?.effectiveFloor.rungId).toBe("r2");
  });
  it("invalidates the active binding and refuses a stale decision", () => {
    const r = router(); r.start({ prompt: "What is JSON?" }); expect(r.providerInput()).toBeDefined();
    const nextMatch = { ...match, modelCatalogRevision: "r2" };
    const nextCapability = { ...capability, match: nextMatch };
    expect(r.activateSnapshot(nextMatch, readySnapshot(nextCapability, admission))).toBe(true);
    expect(r.providerInput()).toBeUndefined();
  });
  it("supports two-rung and five-rung admission profiles without automatic explicit selection", () => {
    const { explicitCeiling: _explicitCeiling, ...twoBase } = capability;
    const twoCapability = {
      ...twoBase,
      rungs: [0, 1].map((ordinal) => ({ id: `r${ordinal}`, ordinal, providerValue: `wire-${ordinal}`, automaticEligible: true, explicitOnly: false })),
      automaticCeiling: "r1",
      anchors: { economical: "r0", balanced: "r0", deliberate: "r1", exhaustive: "r1" },
    };
    const two = router(twoCapability);
    expect(two.start({ prompt: "implement feature" })?.effectiveFloor.rungId).toBe("r0");
    two.onToolError(); expect(two.effectiveRung()?.rungId).toBe("r1");
    expect(parseEffortCommand("/effort r0", two)).toBe(true); expect(two.effectiveRung()?.rungId).toBe("r1");
    const fiveCapability = {
      ...capability,
      rungs: [0, 1, 2, 3, 4].map((ordinal) => ({ id: `r${ordinal}`, ordinal, providerValue: `wire-${ordinal}`, automaticEligible: ordinal < 4, explicitOnly: ordinal === 4 })),
      automaticCeiling: "r3",
      explicitCeiling: "r4",
      anchors: { economical: "r0", balanced: "r1", deliberate: "r2", exhaustive: "r3" },
    };
    const five = router(fiveCapability);
    expect(five.start({ prompt: "/goal architecture" })?.effectiveFloor.rungId).toBe("r3");
    expect(parseEffortCommand("/effort r4", five)).toBe(true); expect(five.effectiveRung()?.rungId).toBe("r4");
  });
  it("keeps status and shadow session-local while refusing unqualified enforce commands", () => {
    const r = router();
    expect(parseEffortCommand("/effort shadow", r)).toBe(true); expect(parseEffortCommand("/effort shadow", r)).toBe(true);
    expect(parseEffortCommand("/effort enforce", r)).toBe(false); expect(parseEffortCommand("/effort status", r)).toBe(true);
    expect(r.status()).toContain("mode:shadow");
  });
  it("retains queued metadata only across a valid snapshot switch and advances generation exactly once", () => {
    const r = router();
    const initialGeneration = r.generation;
    const stable = readySnapshot();
    expect(r.activateSnapshot(match, stable)).toBe(true); expect(r.generation).toBe(initialGeneration);
    r.queueInput({ prompt: "raw?", source: "interactive", streamingBehavior: "followUp" });
    const switchedCapability = { ...capability, source: { kind: "user-approved-local", approvalDigest: "c".repeat(64) } };
    const switched = readySnapshot(switchedCapability);
    expect(r.activateSnapshot(match, switched, { preserveQueuedInput: true })).toBe(true); expect(r.generation).toBe(initialGeneration + 1);
    r.replaceQueuedPrompt("expanded question?"); expect(r.startQueued()?.selectedRung.rungId).toBe("r1");
    r.queueInput({ prompt: "raw?", source: "interactive", streamingBehavior: "followUp" });
    const candidate = createProfileActivationSnapshot({ ...capability, source: { kind: "validated-catalog-candidate", authority: "candidate-only", evidenceDigest: "d".repeat(64) } }, admission);
    expect(r.activateSnapshot(match, candidate, { preserveQueuedInput: true })).toBe(false);
    expect(r.generation).toBe(initialGeneration + 2);
    expect(r.startQueued()).toBeUndefined();
  });
  it("exposes only frozen detached activation material", () => {
    const objectCapability = {
      ...capability,
      rungs: capability.rungs.map((rung, index) => ({ ...rung, providerValue: index === 0 ? { wire: "zero" } : rung.providerValue })),
    };
    const snapshot = readySnapshot(objectCapability);
    expect(Object.isFrozen(snapshot.binding)).toBe(true); expect(Object.isFrozen(snapshot.binding.match)).toBe(true);
    expect(Object.isFrozen(snapshot.capability.rungs)).toBe(true); expect(Object.isFrozen(snapshot.capability.rungs[0]!)).toBe(true);
    expect(Object.isFrozen(snapshot.capability.rungs[0]!.providerValue)).toBe(true); expect(Object.isFrozen(snapshot.capability.anchors)).toBe(true);
    expect(Object.isFrozen(snapshot.admission.evidence)).toBe(true); expect(Object.isFrozen(snapshot.admission.evidence.firstToolError.selector)).toBe(true);
    expect(Object.getPrototypeOf(snapshot.routing.initial)).toBeNull(); expect(Object.getPrototypeOf(snapshot.routing.evidence)).toBeNull(); expect(Object.getPrototypeOf(snapshot.routing.manual)).toBeNull(); expect(Object.getPrototypeOf(snapshot.routing.provider)).toBeNull();
    objectCapability.rungs[0]!.providerValue = "changed";
    expect(snapshot.capability.rungs[0]!.providerValue).toEqual({ wire: "zero" });
    const r = new EpochRouter(); expect(r.activateSnapshot(match, snapshot)).toBe(true); expect(r.start({ prompt: "What is JSON?" })?.selectedRung.rungId).toBe("r0"); expect(r.providerInput()).toBeUndefined();
    const stringProvider = router(); stringProvider.start({ prompt: "What is JSON?" }); const provider = stringProvider.providerInput()!; expect(isTrustedBoundProviderSelection(provider.boundSelection)).toBe(true); expect(Object.isFrozen(provider.boundSelection)).toBe(true);
  });
  it("does not parse or digest profile material during runtime selection and escalation", () => {
    const snapshot = readySnapshot(); const afterPreparation = profilePreparationProbe().bindingDigests;
    const r = new EpochRouter(); expect(r.activateSnapshot(match, snapshot)).toBe(true);
    r.start({ prompt: "What is JSON?" }); r.onToolError(); r.onProviderEnd("length"); r.onCompaction("overflow", true); r.providerInput();
    expect(profilePreparationProbe().bindingDigests).toBe(afterPreparation);
  });
  it("keeps the active epoch monotonic when a lower manual rung replaces an explicit selection", () => {
    const r = router(); r.start({ prompt: "What is JSON?" });
    expect(parseEffortCommand("/effort r3", r)).toBe(true); expect(r.effectiveRung()?.rungId).toBe("r3");
    expect(parseEffortCommand("/effort r1", r)).toBe(true); expect(r.effectiveRung()?.rungId).toBe("r3");
    expect(r.status()).toContain("rung:r1 → r3");
    expect(patchProviderPayload(r.providerInput()!, { reasoning: {} })).toMatchObject({ reasoning: { effort: "wire-3" } });
  });
  it("rejects prototype property command tokens without disturbing later routing", () => {
    const r = router();
    for (const token of ["toString", "constructor", "__proto__"]) expect(parseEffortCommand(`/effort ${token}`, r)).toBe(false);
    expect(() => r.status()).not.toThrow(); expect(r.start({ prompt: "What is JSON?" })?.selectedRung.rungId).toBe("r0");
  });
  it("keeps profile digest work unchanged across repeated bound provider patches", () => {
    const snapshot = readySnapshot(); const afterPreparation = profilePreparationProbe().bindingDigests;
    const r = new EpochRouter(); r.activateSnapshot(match, snapshot); r.start({ prompt: "What is JSON?" });
    expect(patchProviderPayload(r.providerInput()!, { reasoning: {} })).toMatchObject({ reasoning: { effort: "wire-0" } });
    expect(patchProviderPayload(r.providerInput()!, { reasoning: { keep: true } })).toMatchObject({ reasoning: { effort: "wire-0", keep: true } });
    expect(profilePreparationProbe().bindingDigests).toBe(afterPreparation);
  });
  it("freezes failure outcomes and rejects forged activation objects", () => {
    const invalid = createProfileActivationSnapshot({ hostile: true }, { hostile: true });
    const candidate = createProfileActivationSnapshot({ ...capability, source: { kind: "validated-catalog-candidate", authority: "candidate-only", evidenceDigest: "d".repeat(64) } }, admission);
    expect(Object.isFrozen(invalid)).toBe(true); expect(Object.isFrozen(candidate)).toBe(true);
    const r = new EpochRouter();
    expect(r.activateSnapshot(match, { status: "ready" } as unknown as ReturnType<typeof createProfileActivationSnapshot>)).toBe(false);
    expect(r.start({ prompt: "What is JSON?" })).toBeUndefined();
  });
  it.each([
    "status", "auto", "shadow", "enforce", "prototype", ...Object.getOwnPropertyNames(Object.prototype), "has whitespace",
  ])("rejects reserved or whitespace manual rung IDs before issuing a ready snapshot: %s", (token) => {
    const changed = { ...capability, rungs: capability.rungs.map((rung) => rung.id === "r3" ? { ...rung, id: token } : rung), explicitCeiling: token };
    const snapshot = createProfileActivationSnapshot(changed, admission);
    expect(snapshot.status).toBe("invalid"); expect(Object.isFrozen(snapshot)).toBe(true);
    const r = new EpochRouter(); expect(r.activateSnapshot(match, snapshot)).toBe(false); expect(() => r.status()).not.toThrow(); expect(r.start({ prompt: "What is JSON?" })).toBeUndefined();
  });
  it.each([
    "status", "auto", "shadow", "enforce", "prototype", ...Object.getOwnPropertyNames(Object.prototype), "has whitespace",
  ])("rejects reserved or whitespace manual aliases before issuing a ready snapshot: %s", (token) => {
    const changed = { ...capability, rungs: capability.rungs.map((rung) => rung.id === "r3" ? { ...rung, aliases: [token] } : rung) };
    const snapshot = createProfileActivationSnapshot(changed, admission);
    expect(snapshot.status).toBe("invalid"); expect(Object.isFrozen(snapshot)).toBe(true);
  });
  it("accepts near-neighbor manual tokens and rejects an automatic explicit ceiling", () => {
    for (const token of ["status2", "auto-mode", "shadowed", "enforce2", "prototype-safe", "constructor-safe", "__proto___"]) {
      expect(isCommandSafeToken(token)).toBe(true);
      const changed = { ...capability, rungs: capability.rungs.map((rung) => rung.id === "r3" ? { ...rung, aliases: [token] } : rung) };
      const r = router(changed); expect(parseEffortCommand(`/effort ${token}`, r)).toBe(true);
    }
    expect(createProfileActivationSnapshot({ ...capability, explicitCeiling: "r2" }, admission).status).toBe("invalid");
  });
  it("permits a non-addressable internal rung to carry a reserved alias", () => {
    const internal = {
      ...capability,
      rungs: [...capability.rungs, { id: "internal-r4", ordinal: 4, providerValue: "wire-internal", automaticEligible: false, explicitOnly: true, aliases: ["status"] }],
    };
    const snapshot = createProfileActivationSnapshot(internal, admission);
    expect(snapshot.status).toBe("ready");
    if (snapshot.status !== "ready") throw new Error("internal fixture should prepare");
    expect(Object.hasOwn(snapshot.routing.manual, "status")).toBe(false);
  });
});
