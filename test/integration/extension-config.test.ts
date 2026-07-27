import { describe, expect, it } from "vitest";
import { createExtension } from "../../src/index.js";
import { ExtensionHarness } from "./extension-harness.js";
describe("production configuration seam", () => {
  it("preserves baseline with no active profile", async () => { const h = new ExtensionHarness(); await createExtension({ load: async () => ({ enabled: true, mode: "enforce", telemetry: { enabled: true, includePromptText: false, directory: "synthetic" }, ui: { showStatus: true, notifyOnEscalation: false } }) })(h.api()); h.start(); h.input("What is JSON?"); h.before("What is JSON?"); expect(h.request({ reasoning: {} })).toBeUndefined(); });
  it("does not register handlers when disabled", async () => { const h = new ExtensionHarness(); await createExtension({ load: async () => ({ enabled: false, mode: "shadow", telemetry: { enabled: false, includePromptText: false, directory: "synthetic" }, ui: { showStatus: false, notifyOnEscalation: false } }) })(h.api()); expect(h.commands.size).toBe(0); });
});
