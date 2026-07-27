import { describe, expect, it } from "vitest";
import { createExtension } from "../../src/index.js";
import { ExtensionHarness } from "./extension-harness.js";

const config = (overrides: Partial<{ enabled: boolean; mode: "shadow" | "enforce"; ambiguousEffort: "high" | "xhigh"; failureEffort: "high" | "xhigh"; showStatus: boolean; notifyOnEscalation: boolean }> = {}) => ({
  enabled: overrides.enabled ?? true, mode: overrides.mode ?? "shadow", ambiguousEffort: overrides.ambiguousEffort ?? "high", failureEffort: overrides.failureEffort ?? "xhigh",
  telemetry: { enabled: false, includePromptText: false, directory: "synthetic" }, ui: { showStatus: overrides.showStatus ?? true, notifyOnEscalation: overrides.notifyOnEscalation ?? false },
});
const run = (h: ExtensionHarness, text: string) => { h.input(text); h.before(text); return h.request({ reasoning: {} }) as { reasoning?: { effort?: string } } | undefined; };

describe("production configuration seam", () => {
  it("does not register handlers when disabled", async () => { const h = new ExtensionHarness(); await createExtension({ load: async () => config({ enabled: false }) })(h.api()); expect(h.commands.size).toBe(0); });
  it("keeps shadow requests unchanged while an explicit enforce config patches them", async () => {
    const shadow = new ExtensionHarness(); await createExtension({ load: async () => config({ mode: "shadow" }) })(shadow.api()); shadow.start(); expect(run(shadow, "What is JSON?")).toBeUndefined();
    const enforce = new ExtensionHarness(); await createExtension({ load: async () => config({ mode: "enforce" }) })(enforce.api()); enforce.start(); expect(run(enforce, "What is JSON?")?.reasoning?.effort).toBe("low");
  });
  it("uses UI configuration locally and notifies on failure", async () => { const h = new ExtensionHarness(); await createExtension({ load: async () => config({ showStatus: false, notifyOnEscalation: true }) })(h.api()); h.start(); expect(h.status.size).toBe(0); run(h, "What is JSON?"); h.error(); expect(h.notifications).toHaveLength(1); });
  it("applies configured failure floors through production handlers", async () => { const h = new ExtensionHarness(); await createExtension({ load: async () => config({ mode: "enforce", failureEffort: "high" }) })(h.api()); h.start(); run(h, "What is JSON?"); h.error(); expect(run(h, "continue")?.reasoning?.effort).toBe("high"); });
});
