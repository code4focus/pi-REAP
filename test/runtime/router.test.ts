import { describe, expect, it } from "vitest";
import { EpochRouter, parseEffortCommand } from "../../src/runtime/router.js";

describe("epoch router", () => {
  it("allows an independent simple task to reset after a settled complex epoch", () => {
    const router = new EpochRouter();
    expect(router.start({ prompt: "implement this feature and run tests" }).selectedEffort).toBe("high");
    router.onToolError(); router.onToolError(); router.settle();
    const next = router.start({ prompt: "What is JSON?" });
    expect(next.relation).toBe("new"); expect(next.selectedEffort).toBe("low");
  });
  it("inherits an active epoch floor for continuation", () => {
    const router = new EpochRouter();
    router.start({ prompt: "implement this feature" }); router.onToolError(); router.onToolError();
    expect(router.start({ prompt: "continue" }).selectedEffort).toBe("xhigh");
  });
  it("reactivates a settled epoch for an explicit continuation", () => {
    const router = new EpochRouter();
    router.start({ prompt: "implement this feature" }); router.settle();
    const continuation = router.start({ prompt: "continue" });
    expect(router.runtime.currentEpoch?.status).toBe("active"); expect(continuation.relation).toBe("continuation");
  });
  it("applies the xhigh failed-epoch floor when continuing a failed run", () => {
    const router = new EpochRouter(); router.start({ prompt: "What is JSON?" }); router.settle(true);
    expect(router.start({ prompt: "continue" }).selectedEffort).toBe("xhigh");
  });
  it("keeps a settled ambiguous follow-up conservative while standalone architecture starts new", () => {
    const router = new EpochRouter(); router.start({ prompt: "implement this feature" }); router.onToolError(); router.onToolError(); router.settle();
    expect(router.start({ prompt: "that one" }).relation).toBe("ambiguous");
    expect(router.onProviderRequest()).toBe("xhigh");
    router.settle(); expect(router.start({ prompt: "design an architecture plan" }).relation).toBe("new");
  });
  it("raises tool and provider failures monotonically", () => {
    const router = new EpochRouter(); router.start({ prompt: "What is JSON?" });
    expect(router.onProviderRequest()).toBe("low"); router.onToolError(); expect(router.onProviderRequest()).toBe("high"); router.onToolError(); expect(router.onProviderRequest()).toBe("xhigh"); router.onProviderEnd("error"); expect(router.onProviderRequest()).toBe("xhigh");
  });
  it("guards an ambiguous resumed session", () => {
    const router = new EpochRouter({ resumeReason: "resume" });
    expect(router.start({ prompt: "that one" }).selectedEffort).toBe("xhigh");
  });
  it("applies the PR 3 routing configuration without persisting it", () => {
    const router = new EpochRouter({ resumeReason: "resume", config: { mode: "shadow", ambiguousEffort: "xhigh", failureEffort: "high", ui: { showStatus: false, notifyOnEscalation: true } } });
    expect(router.runtime.mode).toBe("shadow");
    expect(router.start({ prompt: "that one" }).selectedEffort).toBe("xhigh");
    const failed = new EpochRouter({ config: { mode: "enforce", ambiguousEffort: "high", failureEffort: "high", ui: { showStatus: true, notifyOnEscalation: false } } });
    failed.start({ prompt: "What is JSON?" }); failed.onToolError();
    expect(failed.onProviderRequest()).toBe("high");
  });
  it.each(["continue", "fix it"])("guards resumed continuation %s when context is unavailable", (prompt) => {
    const router = new EpochRouter({ resumeReason: "resume" });
    expect(router.start({ prompt }).selectedEffort).toBe("xhigh");
  });
  it("does not over-escalate an ordinary active continuation", () => {
    const router = new EpochRouter(); router.start({ prompt: "What is JSON?" });
    expect(router.start({ prompt: "continue" }).selectedEffort).toBe("high");
  });
  it("keeps max session-only and never automatic", () => {
    const router = new EpochRouter(); router.start({ prompt: "What is JSON?" });
    expect(router.effectiveEffort()).toBe("low"); expect(parseEffortCommand("/effort max", router)).toBe(true); expect(router.effectiveEffort()).toBe("max");
    router.settle();
    expect(router.start({ prompt: "new question: what is YAML?" }).selectedEffort).toBe("low");
  });
  it("supports only local status and mode commands", () => {
    const router = new EpochRouter(); router.start({ prompt: "What is JSON?" });
    expect(parseEffortCommand("/effort shadow", router)).toBe(true); expect(router.runtime.mode).toBe("shadow");
    expect(parseEffortCommand("/effort status", router)).toBe(true); expect(router.status()).toContain("effort:auto → low");
    expect(parseEffortCommand("/effort invalid", router)).toBe(false);
  });
  it("does not lower within generated event sequences", () => {
    for (let seed = 0; seed < 40; seed += 1) {
      const router = new EpochRouter(); router.start({ prompt: "What is JSON?" }); let prior = router.onProviderRequest()!;
      const ranks = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 } as const;
      for (let i = 0; i < 20; i += 1) { if ((seed + i) % 7 === 0) router.onCompaction("overflow", true); else if ((seed + i) % 5 === 0) router.start({ prompt: "continue" }); else if ((seed + i) % 3 === 0) router.onToolError(); else if ((seed + i) % 2 === 0) router.onToolCall("write"); else router.onProviderEnd("aborted"); const current = router.onProviderRequest()!; expect(ranks[current]).toBeGreaterThanOrEqual(ranks[prior]); prior = current; }
    }
  });
  it("resets only after an explicit settled independent input in generated sequences", () => {
    for (let seed = 0; seed < 30; seed += 1) {
      const router = new EpochRouter(); router.start({ prompt: "implement this feature" });
      for (let i = 0; i < seed % 6; i += 1) router.onToolError();
      router.settle();
      expect(router.start({ prompt: "What is JSON?" }).selectedEffort).toBe("low");
    }
  });
});
