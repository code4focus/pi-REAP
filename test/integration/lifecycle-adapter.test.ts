import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtension } from "../../src/index.js";
import { ExtensionHarness } from "./extension-harness.js";

const match = { provider: "openai", api: "openai-responses", model: "m", modelCatalogRevision: "r", modelCatalogDigest: "a".repeat(64), piVersion: "0.82.1", providerAdapterRevision: "r", providerAdapterDigest: "b".repeat(64) };
const profiles = {
  capability: {
    schemaVersion: 1, profileId: "cap", profileRevision: "1", source: { kind: "repository-pinned", repositoryRevision: "r" }, match,
    rungs: [0, 1, 2, 3].map((ordinal) => ({ id: `r${ordinal}`, ordinal, providerValue: `wire-${ordinal}`, automaticEligible: ordinal < 3, explicitOnly: ordinal === 3 })),
    automaticFloor: "r0", automaticCeiling: "r2", explicitCeiling: "r3",
    anchors: { economical: "r0", balanced: "r1", deliberate: "r2", exhaustive: "r2" }, baselineBehavior: "preserve-request",
  },
  admission: {
    schemaVersion: 1, profileId: "adm", profileRevision: "1", source: { kind: "repository-pinned", repositoryRevision: "r" },
    capabilityProfileId: "cap", capabilityProfileRevision: "1",
    initial: { simpleQuery: { kind: "lowest-automatic" }, boundedRead: { kind: "next-above-lowest" }, implementation: { kind: "anchor", name: "balanced" }, debugging: { kind: "anchor", name: "deliberate" }, architecture: { kind: "automatic-ceiling" }, highRisk: { kind: "automatic-ceiling" }, continuation: { kind: "anchor", name: "balanced" }, unknown: { kind: "automatic-ceiling" } },
    evidence: Object.fromEntries(["firstToolError", "repeatedToolError", "providerError", "lengthExhaustion", "overflowRetry", "failedContinuation"].map((key) => [key, { selector: { kind: "automatic-ceiling" } }])),
  },
};
const config = { enabled: true, mode: "enforce", telemetry: { enabled: false, includePromptText: false, directory: "synthetic" }, ui: { showStatus: true, notifyOnEscalation: false } } as const;
const activation = { capability: profiles.capability, admission: profiles.admission, modelCatalogRevision: "r", modelCatalogDigest: "a".repeat(64), piVersion: "0.82.1", providerAdapterRevision: "r", providerAdapterDigest: "b".repeat(64) };
const extension = () => ({ load: async () => config, activation });
const route = (h: ExtensionHarness, text: string) => { h.input(text); h.before(text); return h.request({ reasoning: { effort: "baseline" } }); };

describe("Pi 0.82.1 lifecycle adapter in production-safe shadow", () => {
  it("registers a read-only profile-neutral conflict diagnostic for a valid activation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-reap-conflict-command-"));
    try {
      const h = new ExtensionHarness();
      await createExtension({
        load: async () => ({ ...config, telemetry: { enabled: true, includePromptText: false, directory } }),
        activation,
        telemetryDirectory: directory,
        sessionId: "synthetic-conflict-command",
        telemetryNonce: () => "fixed",
      })(h.api());
      h.start();
      const beforeStatus = h.status.get("pi-reap");
      const command = h.commands.get("effort-conflict");
      expect(command?.description).toContain("activation and profile conflict");
      expect(h.tools).toEqual([]);
      expect(readdirSync(directory)).toEqual([]);
      await command!.handler("private-user-content-must-not-appear", h.context);
      expect(h.providerHookInvocations).toBe(0);
      expect(readdirSync(directory)).toEqual([]);
      expect(h.status.get("pi-reap")).toBe(beforeStatus);
      const diagnostic = h.status.get("pi-reap-conflict")!;
      expect(diagnostic).toContain("activation=prepared profile=ready source=authorized conflict=none runtime=active failClosed=false");
      expect(diagnostic).toMatch(/capabilityDigest=[a-f0-9]{64} admissionDigest=[a-f0-9]{64} matchDigest=[a-f0-9]{64}/);
      expect(diagnostic).toMatch(/capabilitySource=repository-pinned:[a-f0-9]{64} admissionSource=repository-pinned:[a-f0-9]{64}/);
      expect(diagnostic).not.toContain("private-user-content");
      expect(route(h, "Explain this file.")).toBeUndefined();
      expect(h.status.get("pi-reap")).toContain("rung:auto → r1");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["profile reference", { ...activation, admission: { ...profiles.admission, capabilityProfileId: "cap-conflict" } }, "profile=conflicted source=unavailable conflict=profile-reference"],
    ["source", { ...activation, admission: { ...profiles.admission, source: { kind: "validated-catalog-candidate", authority: "candidate-only", evidenceDigest: "c".repeat(64) } } }, "profile=conflicted source=conflicted conflict=source-disagreement"],
  ] as const)("reports a fail-closed %s conflict without provider or telemetry mutation", async (_kind, conflictedActivation, expected) => {
    const directory = mkdtempSync(join(tmpdir(), "pi-reap-conflict-command-"));
    try {
      const h = new ExtensionHarness();
      await createExtension({
        load: async () => ({ ...config, telemetry: { enabled: true, includePromptText: false, directory } }),
        activation: conflictedActivation,
        telemetryDirectory: directory,
        sessionId: "synthetic-conflicted-command",
        telemetryNonce: () => "fixed",
      })(h.api());
      h.start();
      expect(h.status.get("pi-reap")).toContain("profile:unresolved");
      const beforeStatus = h.status.get("pi-reap");
      await h.commands.get("effort-conflict")!.handler("ignored-private-content", h.context);
      expect(h.providerHookInvocations).toBe(0);
      expect(existsSync(directory) ? readdirSync(directory) : []).toEqual([]);
      expect(h.status.get("pi-reap")).toBe(beforeStatus);
      const diagnostic = h.status.get("pi-reap-conflict")!;
      expect(diagnostic).toContain(expected);
      expect(diagnostic).toContain("runtime=profile-unavailable failClosed=true");
      expect(diagnostic).not.toContain("ignored-private-content");
      expect(route(h, "What is JSON?")).toBeUndefined();
      expect(h.status.get("pi-reap")).toContain("profile:unresolved");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("decides before the first request but refuses enforcement without approved evidence", async () => {
    const h = new ExtensionHarness(); await createExtension(extension())(h.api()); h.start();
    await h.commands.get("effort")!.handler("enforce", h.context);
    expect(route(h, "What is JSON?")).toBeUndefined();
    expect(h.status.get("pi-reap")).toContain("rung:auto → r0");
    expect(h.status.get("pi-reap")).toContain("mode:shadow");
  });

  it("retains profile-relative failure escalation while preserving the provider baseline", async () => {
    const h = new ExtensionHarness(); await createExtension(extension())(h.api()); h.start();
    route(h, "What is JSON?"); h.error();
    expect(h.request({ reasoning: { effort: "baseline" } })).toBeUndefined();
    expect(h.status.get("pi-reap")).toContain("rung:auto → r2");
  });

  it.each(["provider", "api", "id"] as const)("refuses a real ctx.model %s mismatch", async (field) => {
    const h = new ExtensionHarness(); await createExtension(extension())(h.api()); h.start(); h.setModel({ [field]: "other" });
    expect(route(h, "What is JSON?")).toBeUndefined();
    expect(h.status.get("pi-reap")).toContain("profile:unresolved");
  });

  it.each(["modelCatalogRevision", "modelCatalogDigest", "piVersion", "providerAdapterRevision", "providerAdapterDigest"] as const)("refuses activation %s mismatch", async (field) => {
    const h = new ExtensionHarness(); const changed = { ...activation, [field]: field.includes("Digest") ? "c".repeat(64) : "other" };
    await createExtension({ ...extension(), activation: changed })(h.api()); h.start();
    expect(route(h, "What is JSON?")).toBeUndefined();
    expect(h.status.get("pi-reap")).toContain("profile:unresolved");
  });

  it("uses a detached activation snapshot despite later caller mutation", async () => {
    const mutable: { capability: unknown; admission: unknown; modelCatalogRevision: string; modelCatalogDigest: string; piVersion: string; providerAdapterRevision: string; providerAdapterDigest: string } = { ...activation, capability: { ...profiles.capability }, admission: { ...profiles.admission } };
    const h = new ExtensionHarness(); await createExtension({ ...extension(), activation: mutable })(h.api());
    mutable.capability = { ...profiles.capability, source: { kind: "validated-catalog-candidate", authority: "candidate-only", evidenceDigest: "d".repeat(64) } };
    h.start(); expect(route(h, "What is JSON?")).toBeUndefined();
    expect(h.status.get("pi-reap")).toContain("profile:cap@1");
  });

  it("rejects hostile activation accessors without executing them", async () => {
    let accesses = 0;
    const hostile = Object.defineProperty({ ...activation }, "capability", { enumerable: true, get: () => { accesses += 1; throw new Error("hostile"); } });
    const h = new ExtensionHarness(); await createExtension({ ...extension(), activation: hostile })(h.api()); h.start();
    expect(route(h, "What is JSON?")).toBeUndefined(); expect(accesses).toBe(0);
  });

  it("clears queued input across an unresolved profile boundary", async () => {
    const h = new ExtensionHarness(); await createExtension(extension())(h.api()); h.start();
    h.input("queued?", "followUp"); h.setModel({ provider: "other" }); h.before("expanded queued?");
    expect(h.request({ reasoning: {} })).toBeUndefined();
    h.setModel({ provider: "openai" }); h.before("restored without new input?");
    expect(h.request({ reasoning: {} })).toBeUndefined();
  });
});
