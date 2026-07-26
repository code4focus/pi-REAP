import { describe, expect, it } from "vitest";
import { ExtensionHarness } from "./extension-harness.js";

describe("typed extension lifecycle harness", () => {
  it("preserves registration order and chains handler return values", () => {
    const harness = new ExtensionHarness();
    const calls: string[] = [];
    harness.on("compaction_retry", (event) => { calls.push(`first:${event.attempt}`); return { attempt: event.attempt + 1 }; });
    harness.on("compaction_retry", (event) => { calls.push(`second:${event.attempt}`); return { attempt: event.attempt + 1 }; });
    const result = harness.emit("compaction_retry", { ctx: { model: { id: "synthetic", provider: "test" } }, attempt: 1 });
    expect(calls).toEqual(["first:1", "second:2"]);
    expect(result.attempt).toBe(3);
  });
});
