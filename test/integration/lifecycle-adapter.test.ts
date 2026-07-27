import { describe, expect, it } from "vitest";
import { createExtension } from "../../src/index.js";
import { ExtensionHarness } from "./extension-harness.js";

const effort = (payload: unknown) => (payload as { reasoning?: { effort?: string } }).reasoning?.effort;
const run = (harness: ExtensionHarness, text: string) => { harness.input(text); harness.before(text); return harness.request({ reasoning: {} }); };
const extension = createExtension({ load: async () => ({ enabled: true, mode: "enforce", ambiguousEffort: "high", failureEffort: "xhigh", telemetry: { enabled: false, includePromptText: false, directory: "synthetic" }, ui: { showStatus: true, notifyOnEscalation: false } }) });

describe("Pi 0.82.1 lifecycle adapter", () => {
  it.each(["new", "resume", "fork", "reload"] as const)("clears max across %s session replacement", async (reason) => {
    const h = new ExtensionHarness(); await extension(h.api()); h.start();
    await h.commands.get("effort")!.handler("max", h.context); h.shutdown(reason); h.start(reason);
    expect(effort(run(h, "What is JSON?"))).toBe("low");
  });
  it("treats independent settled reads as a new epoch without a fictional new marker", async () => {
    const h = new ExtensionHarness(); await extension(h.api()); h.start();
    expect(effort(run(h, "implement this feature"))).toBe("high"); h.error(); h.error(); h.settled();
    expect(effort(run(h, "explain this file"))).toBe("medium");
  });
  it("starts an independent implementation at high after a settled xhigh epoch", async () => {
    const h = new ExtensionHarness(); await extension(h.api()); h.start(); run(h, "implement this feature"); h.error(); h.error(); h.settled();
    expect(effort(run(h, "implement a separate feature"))).toBe("high");
  });
  it("retains a failed run as xhigh only for a continuation", async () => {
    const h = new ExtensionHarness(); await extension(h.api()); h.start(); run(h, "What is JSON?"); h.message("error"); h.settled();
    expect(effort(run(h, "continue"))).toBe("xhigh");
  });
  it("guards ambiguous resumes", async () => {
    const h = new ExtensionHarness(); await extension(h.api()); h.start("resume");
    expect(effort(run(h, "that one"))).toBe("xhigh");
  });
  it("clears a recorded failure after a successful terminal assistant message", async () => {
    const h = new ExtensionHarness(); await extension(h.api()); h.start(); run(h, "What is JSON?"); h.message("error"); h.message("stop"); h.settled();
    expect(effort(run(h, "explain this file"))).toBe("medium");
  });
  it("treats length as failed but aborted as non-failing", async () => {
    const length = new ExtensionHarness(); await extension(length.api()); length.start(); run(length, "What is JSON?"); length.message("length"); length.settled();
    expect(effort(run(length, "continue"))).toBe("xhigh");
    const aborted = new ExtensionHarness(); await extension(aborted.api()); aborted.start(); expect(effort(run(aborted, "What is JSON?"))).toBe("low"); aborted.message("aborted"); aborted.settled();
    expect(effort(run(aborted, "explain this file"))).toBe("medium");
  });
  it("is monotonic through production lifecycle failures", async () => {
    const h = new ExtensionHarness(); await extension(h.api()); h.start(); expect(effort(run(h, "What is JSON?"))).toBe("low"); h.error(); expect(effort(h.request({ reasoning: {} }))).toBe("xhigh"); h.error(); expect(effort(h.request({ reasoning: {} }))).toBe("xhigh");
  });
});
