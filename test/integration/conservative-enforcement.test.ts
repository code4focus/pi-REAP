import { describe, expect, it } from "vitest";
import { createExtension } from "../../src/index.js";
import type { ProfileQualification } from "../../src/qualification/enforcement.js";
import { profileFixtures } from "../../eval/corpus/manifest.js";
import { ExtensionHarness } from "./extension-harness.js";

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
const config = async () => ({ enabled: true, mode: "enforce" as const, telemetry: { enabled: false, includePromptText: false, directory: "synthetic" }, ui: { showStatus: true, notifyOnEscalation: false } });
const start = (harness: ExtensionHarness, prompt = "What is JSON?") => { harness.input(prompt); harness.before(prompt); };

describe("PR 6 conservative production enforcement", () => {
  it("keeps default and configured enforcement shadow without an externally approved successor artifact", async () => {
    const harness = new ExtensionHarness(); harness.setModel({ id: profile.capability.match.model });
    await createExtension({ load: config, activation })(harness.api()); harness.start();
    await harness.commands.get("effort")!.handler("enforce", harness.context);
    start(harness);
    expect(harness.request({ reasoning: { effort: "baseline" } })).toBeUndefined();
    expect(harness.status.get("pi-reap")).toContain("mode:shadow");
  });

  it("exposes no caller qualification route and ignores a forged lookalike property", async () => {
    const forged = Object.freeze({ artifact: {}, attestation: {}, artifactDigest: "a".repeat(64) }) as unknown as ProfileQualification;
    // A JavaScript caller may still attach an unknown property; the extension
    // does not read it and the TypeScript production options do not expose it.
    const callerOptions = { load: config, activation, qualification: forged };
    const harness = new ExtensionHarness(); harness.setModel({ id: profile.capability.match.model });
    await createExtension(callerOptions)(harness.api()); harness.start();
    await harness.commands.get("effort")!.handler("enforce", harness.context);
    start(harness); expect(harness.request({ reasoning: {} })).toBeUndefined();
    expect(harness.request({ reasoning: {} })).toBeUndefined();
    expect(harness.status.get("pi-reap")).toContain("mode:shadow");
  });

  it("revokes session-local state on session and profile boundaries", async () => {
    const harness = new ExtensionHarness(); harness.setModel({ id: profile.capability.match.model });
    await createExtension({ load: config, activation })(harness.api()); harness.start();
    await harness.commands.get("effort")!.handler(profile.capability.explicitCeiling ?? "auto", harness.context);
    harness.shutdown(); harness.start(); start(harness); expect(harness.request({ reasoning: {} })).toBeUndefined();
    harness.setModel({ provider: "other" }); start(harness); expect(harness.request({ reasoning: {} })).toBeUndefined();
    expect(harness.status.get("pi-reap")).toContain("profile:unresolved");
  });
});
