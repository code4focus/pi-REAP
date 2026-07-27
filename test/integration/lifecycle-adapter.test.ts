import { describe, expect, it } from "vitest";
import { createExtension } from "../../src/index.js";
import { ExtensionHarness } from "./extension-harness.js";
const match = { provider: "openai", api: "openai-responses", model: "m", modelCatalogRevision: "r", modelCatalogDigest: "a".repeat(64), piVersion: "0.82.1", providerAdapterRevision: "r", providerAdapterDigest: "b".repeat(64) };
const profiles = { capability: { schemaVersion: 1, profileId: "cap", profileRevision: "1", source: { kind: "repository-pinned", repositoryRevision: "r" }, match, rungs: [0, 1, 2, 3].map((ordinal) => ({ id: `r${ordinal}`, ordinal, providerValue: `wire-${ordinal}`, automaticEligible: ordinal < 3, explicitOnly: ordinal === 3 })), automaticFloor: "r0", automaticCeiling: "r2", explicitCeiling: "r3", anchors: { economical: "r0", balanced: "r1", deliberate: "r2", exhaustive: "r2" }, baselineBehavior: "preserve-request" }, admission: { schemaVersion: 1, profileId: "adm", profileRevision: "1", source: { kind: "repository-pinned", repositoryRevision: "r" }, capabilityProfileId: "cap", capabilityProfileRevision: "1", initial: { simpleQuery: { kind: "lowest-automatic" }, boundedRead: { kind: "next-above-lowest" }, implementation: { kind: "anchor", name: "balanced" }, debugging: { kind: "anchor", name: "deliberate" }, architecture: { kind: "automatic-ceiling" }, highRisk: { kind: "automatic-ceiling" }, continuation: { kind: "anchor", name: "balanced" }, unknown: { kind: "automatic-ceiling" } }, evidence: Object.fromEntries(["firstToolError", "repeatedToolError", "providerError", "lengthExhaustion", "overflowRetry", "failedContinuation"].map((key) => [key, { selector: { kind: "automatic-ceiling" } }])) } };
const config = { enabled: true, mode: "enforce", telemetry: { enabled: true, includePromptText: false, directory: "synthetic" }, ui: { showStatus: true, notifyOnEscalation: false } } as const;
const activation = { capability: profiles.capability, admission: profiles.admission, modelCatalogRevision: "r", modelCatalogDigest: "a".repeat(64), piVersion: "0.82.1", providerAdapterRevision: "r", providerAdapterDigest: "b".repeat(64) };
const run = (h: ExtensionHarness, text: string) => { h.input(text); h.before(text); return (h.request({ reasoning: {} }) as { reasoning: { effort: string } }).reasoning.effort; };
describe("Pi 0.82.1 lifecycle adapter", () => {
  it("decides before first request and clears explicit override on session reset", async () => { const h = new ExtensionHarness(); await createExtension({ load: async () => config, activation })(h.api()); h.start(); expect(run(h, "What is JSON?")).toBe("wire-0"); await h.commands.get("effort")!.handler("r3", h.context); h.shutdown(); h.start(); expect(run(h, "What is JSON?")).toBe("wire-0"); });
  it("escalates real lifecycle failures and failed continuation", async () => { const h = new ExtensionHarness(); await createExtension({ load: async () => config, activation })(h.api()); h.start(); run(h, "What is JSON?"); h.error(); expect(h.request({ reasoning: {} })).toMatchObject({ reasoning: { effort: "wire-2" } }); h.message("error"); h.settled(); expect(run(h, "continue")).toBe("wire-2"); });
  it.each(["provider", "api", "id"] as const)("refuses a real ctx.model %s mismatch", async (field) => {
    const h = new ExtensionHarness(); await createExtension({ load: async () => config, activation })(h.api()); h.start(); h.setModel({ [field]: "other" }); h.input("What is JSON?"); h.before("What is JSON?"); expect(h.request({ reasoning: {} })).toBeUndefined();
  });
  it("revokes during session_start when the live model is already mismatched", async () => {
    const h = new ExtensionHarness(); h.setModel({ provider: "other" }); await createExtension({ load: async () => config, activation })(h.api()); h.start();
    expect(h.status.get("pi-reap")).toContain("profile:unresolved"); expect(h.request({ reasoning: {} })).toBeUndefined();
  });
  it.each(["modelCatalogRevision", "modelCatalogDigest", "piVersion", "providerAdapterRevision", "providerAdapterDigest"] as const)("refuses attestation %s mismatch", async (field) => {
    const h = new ExtensionHarness(); const changed = { ...activation, [field]: field.includes("Digest") ? "c".repeat(64) : "other" };
    await createExtension({ load: async () => config, activation: changed })(h.api()); h.start(); h.input("What is JSON?"); h.before("What is JSON?"); expect(h.request({ reasoning: {} })).toBeUndefined();
  });
  it("uses a detached activation snapshot despite later caller mutation", async () => {
    const h = new ExtensionHarness(); const mutable: { capability: unknown; admission: unknown; modelCatalogRevision: string; modelCatalogDigest: string; piVersion: string; providerAdapterRevision: string; providerAdapterDigest: string } = { ...activation, capability: { ...profiles.capability }, admission: { ...profiles.admission } };
    await createExtension({ load: async () => config, activation: mutable })(h.api());
    mutable.capability = { ...profiles.capability, source: { kind: "user-approved-local", approvalDigest: "c".repeat(64) } };
    mutable.capability = { ...profiles.capability, source: { kind: "validated-catalog-candidate", authority: "candidate-only", evidenceDigest: "d".repeat(64) } };
    h.start(); expect(run(h, "What is JSON?")).toBe("wire-0");
  });
  it("rejects a prepared candidate and hostile activation accessors without patching", async () => {
    const candidate = { ...activation, capability: { ...profiles.capability, source: { kind: "validated-catalog-candidate", authority: "candidate-only", evidenceDigest: "d".repeat(64) } } };
    const candidateHarness = new ExtensionHarness(); await createExtension({ load: async () => config, activation: candidate })(candidateHarness.api()); candidateHarness.start(); candidateHarness.input("What is JSON?"); candidateHarness.before("What is JSON?"); expect(candidateHarness.request({ reasoning: {} })).toBeUndefined();
    let accesses = 0;
    const hostile = Object.defineProperty({ ...activation }, "capability", { enumerable: true, get: () => { accesses += 1; throw new Error("hostile"); } });
    const hostileHarness = new ExtensionHarness(); await createExtension({ load: async () => config, activation: hostile })(hostileHarness.api()); hostileHarness.start(); hostileHarness.input("What is JSON?"); hostileHarness.before("What is JSON?"); expect(hostileHarness.request({ reasoning: {} })).toBeUndefined(); expect(accesses).toBe(0);
  });
  it("revokes hostile model metadata and requires a fresh decision after identity recovery", async () => {
    const h = new ExtensionHarness(); await createExtension({ load: async () => config, activation })(h.api()); h.start(); run(h, "What is JSON?");
    let accesses = 0;
    Object.defineProperty((h.context as { model: object }).model, "provider", { enumerable: true, configurable: true, get: () => { accesses += 1; throw new Error("hostile"); } });
    expect(h.request({ reasoning: {} })).toBeUndefined(); expect(accesses).toBe(0); expect(h.status.get("pi-reap")).toContain("profile:unresolved");
    Object.defineProperty((h.context as { model: object }).model, "provider", { enumerable: true, configurable: true, writable: true, value: "openai" });
    expect(h.request({ reasoning: {} })).toBeUndefined();
    expect(run(h, "What is JSON?")).toBe("wire-0");
  });
  it("clears queued input on an unresolved before-agent boundary and never revives it after identity recovery", async () => {
    const h = new ExtensionHarness(); await createExtension({ load: async () => config, activation })(h.api()); h.start();
    h.input("queued?", "followUp"); h.setModel({ provider: "other" }); h.before("expanded queued?");
    expect(h.request({ reasoning: {} })).toBeUndefined();
    h.setModel({ provider: "openai" }); h.before("restored without new input?");
    expect(h.request({ reasoning: {} })).toBeUndefined();
    h.input("fresh?"); h.before("fresh?"); expect(h.request({ reasoning: {} })).toMatchObject({ reasoning: { effort: "wire-0" } });
  });
  it("uses the expanded prompt but keeps queued streaming metadata", async () => {
    const h = new ExtensionHarness(); await createExtension({ load: async () => config, activation })(h.api()); h.start(); h.input("raw?", "followUp"); h.before("expanded question?"); expect(h.request({ reasoning: {} })).toMatchObject({ reasoning: { effort: "wire-1" } });
  });
  it("handles local commands before the first task and resets them on session replacement", async () => {
    const h = new ExtensionHarness(); await createExtension({ load: async () => config, activation })(h.api()); h.start();
    expect(await h.commands.get("effort")!.handler("r3", h.context)).toBeUndefined();
    expect(await h.commands.get("effort")!.handler("r3", h.context)).toBeUndefined();
    expect(run(h, "What is JSON?")).toBe("wire-3"); h.shutdown("new"); h.start("new"); expect(run(h, "What is JSON?")).toBe("wire-0");
  });
  it("never lowers a live epoch when a lower local command follows an explicit rung", async () => {
    const h = new ExtensionHarness(); await createExtension({ load: async () => config, activation })(h.api()); h.start(); run(h, "What is JSON?");
    await h.commands.get("effort")!.handler("r3", h.context); expect(h.request({ reasoning: {} })).toMatchObject({ reasoning: { effort: "wire-3" } });
    await h.commands.get("effort")!.handler("r1", h.context); expect(h.request({ reasoning: {} })).toMatchObject({ reasoning: { effort: "wire-3" } });
  });
});
