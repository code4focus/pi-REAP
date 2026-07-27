import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExtension } from "../../src/index.js";
import { withoutReasoningEffort } from "../../src/provider/patch.js";
import { ExtensionHarness, type SyntheticContext } from "./extension-harness.js";

const directories: string[] = [];
const directory = (): string => { const path = mkdtempSync(join(tmpdir(), "pi-reap-pr6-")); directories.push(path); return path; };
const supported: SyntheticContext = { model: { id: "synthetic-openai", provider: "openai", api: "openai-responses", reasoning: true } };
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

function start(harness: ExtensionHarness, text: string, ctx = supported): void {
  harness.emit("input", { ctx, input: { text } });
  harness.emit("before_agent_start", { ctx });
}

describe("PR 6 conservative enforcement (synthetic lifecycle coverage)", () => {
  it.each([
    ["What is JSON?", "low"],
    ["Explain this read-only file", "medium"],
    ["implement this function", "high"],
    ["debug this failing test", "high"],
    ["review this concurrent permission migration", "xhigh"],
  ] as const)("patches the frozen initial routing table for %s", (text, effort) => {
    const harness = new ExtensionHarness(); createExtension({ telemetryDirectory: directory(), mode: "enforce" })(harness); start(harness, text);
    const original = { instructions: "synthetic", input: [{ role: "user", content: "synthetic" }], tools: [{ type: "function", name: "synthetic" }], tool_choice: "auto", prompt_cache_key: "synthetic-cache", prompt_cache_options: { mode: "explicit" }, prompt_cache_retention: "24h", reasoning: { summary: "none", context: "opaque", encrypted_content: "synthetic" }, previous_response_id: "synthetic-previous", transport: { retries: 2 } };
    const result = harness.emit("before_provider_request", { ctx: supported, request: { payload: original } });
    expect(withoutReasoningEffort(result.request.payload)).toStrictEqual(withoutReasoningEffort(original));
    expect((result.request.payload as { reasoning: { effort: string } }).reasoning.effort).toBe(effort);
    expect(harness.setThinkingLevelCalls).toEqual([]);
  });

  it("moves from shadow recommendation to exactly one request-local enforce patch", async () => {
    const path = directory(); const harness = new ExtensionHarness(); createExtension({ telemetryDirectory: path })(harness);
    const original = { input: "synthetic", prompt_cache_key: "cache", reasoning: { effort: "xhigh", context: "opaque" } };
    await harness.commands.get("effort")!.handler("shadow", { ui: { setStatus() {} } });
    start(harness, "What is JSON?");
    expect(harness.emit("before_provider_request", { ctx: supported, request: { payload: original } }).request.payload).toBe(original);
    harness.emit("message_end", { ctx: supported, stopReason: "stop", message: { role: "assistant", usage: { cacheReadTokens: 4, cacheWriteTokens: 0 } } });
    harness.emit("agent_settled", { ctx: supported });
    await harness.commands.get("effort")!.handler("enforce", { ui: { setStatus() {} } });
    start(harness, "What is JSON?");
    const enforced = harness.emit("before_provider_request", { ctx: supported, request: { payload: original } }).request.payload;
    expect(enforced).not.toBe(original); expect(withoutReasoningEffort(enforced)).toStrictEqual(withoutReasoningEffort(original));
    harness.emit("message_end", { ctx: supported, stopReason: "stop", message: { role: "assistant", usage: { cacheReadTokens: 4, cacheWriteTokens: 0 } } });
    const requestRecords = readFileSync(join(path, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { patchStatus: string; cacheReadTokens?: number; cacheWriteTokens?: number });
    expect(requestRecords).toHaveLength(2);
    expect(requestRecords).toEqual(expect.arrayContaining([expect.objectContaining({ patchStatus: "shadow", cacheReadTokens: 4, cacheWriteTokens: 0 }), expect.objectContaining({ patchStatus: "applied", cacheReadTokens: 4, cacheWriteTokens: 0 })]));
    const statuses: string[] = [];
    await harness.commands.get("effort")!.handler("shadow", { ui: { setStatus(_key, value) { statuses.push(value ?? ""); } } });
    await harness.commands.get("effort")!.handler("status", { ui: { setStatus(_key, value) { statuses.push(value ?? ""); } } });
    expect(statuses.at(-1)).toContain("mode:shadow");
  });

  it("uses safe shadow startup for absent or invalid local options", () => {
    for (const options of [{ telemetryDirectory: directory() }, { telemetryDirectory: directory(), mode: "invalid" as unknown }]) {
      const harness = new ExtensionHarness(); createExtension(options)(harness); start(harness, "What is JSON?");
      const original = { input: "synthetic", reasoning: { effort: "xhigh", context: "opaque" } };
      expect(harness.emit("before_provider_request", { ctx: supported, request: { payload: original } }).request.payload).toBe(original);
      expect(harness.setThinkingLevelCalls).toEqual([]); expect(harness.registerToolCalls).toEqual([]);
    }
  });

  it("registers a Pi-local conflict command with explicit local-not-wire guidance", async () => {
    const harness = new ExtensionHarness(); createExtension({ telemetryDirectory: directory() })(harness);
    expect(harness.registerToolCalls).toEqual([]);
    const messages: string[] = []; const context = { ui: { setStatus(_key: string, value: string | undefined) { messages.push(value ?? ""); } } };
    await harness.commands.get("effort-conflict")!.handler("high low", context);
    expect(messages.at(-1)).toContain("place Pi REAP last"); expect(messages.at(-1)).toContain("final-payload logger"); expect(messages.at(-1)).toContain("Local observation"); expect(messages.at(-1)).toContain("not provider wire truth");
    await harness.commands.get("effort-conflict")!.handler("bad", context);
    expect(messages.at(-1)).toContain("local observations only, not provider wire truth");
    expect(harness.setThinkingLevelCalls).toEqual([]);
  });

  it("leaves unsupported and conflicted requests unchanged as the baseline fallback", () => {
    for (const ctx of [
      { model: { id: "unsupported", provider: "other", api: "other", reasoning: true } },
      { model: { id: "conflicted", provider: "openai", api: "openai-responses", reasoning: true, thinkingLevelMap: { low: 1 } } },
    ] satisfies SyntheticContext[]) {
      const harness = new ExtensionHarness(); createExtension({ telemetryDirectory: directory(), mode: "enforce" })(harness); start(harness, "What is JSON?", ctx);
      const original = { input: "synthetic", reasoning: { effort: "xhigh", context: "opaque" } };
      expect(harness.emit("before_provider_request", { ctx, request: { payload: original } }).request.payload).toBe(original);
    }
  });
});
