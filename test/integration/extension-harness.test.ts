import { describe, expect, it } from "vitest";
import { ExtensionHarness } from "./extension-harness.js";

describe("typed extension lifecycle harness", () => {
  it("preserves registration order and chains handler return values", () => {
    const harness = new ExtensionHarness();
    const calls: string[] = [];
    harness.on("before_agent_start", (event) => { calls.push(`first:${event.systemPrompt}`); return { systemPrompt: `${event.systemPrompt} first` }; });
    harness.on("before_agent_start", (event) => { calls.push(`second:${event.systemPrompt}`); return { systemPrompt: `${event.systemPrompt} second` }; });
    const result = harness.emitBeforeAgentStart({
      type: "before_agent_start",
      prompt: "synthetic",
      systemPrompt: "synthetic system prompt",
      systemPromptOptions: { cwd: "/synthetic" },
    });
    expect(calls).toEqual(["first:synthetic system prompt", "second:synthetic system prompt first"]);
    expect(result).toEqual({ systemPrompt: "synthetic system prompt first second" });
  });
});
