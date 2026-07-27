import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExtension } from "../../src/index.js";
import { withoutReasoningEffort } from "../../src/provider/patch.js";
import { ExtensionHarness } from "./extension-harness.js";

const directories: string[] = [];
const directory = (): string => { const path = mkdtempSync(join(tmpdir(), "pi-reap-pr6-")); directories.push(path); return path; };
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

async function start(harness: ExtensionHarness, text: string): Promise<void> { harness.input(text); harness.before(text); }
const config = (directory: string, mode: "shadow" | "enforce" = "shadow") => async () => ({ enabled: true, mode, ambiguousEffort: "high" as const, failureEffort: "xhigh" as const, telemetry: { enabled: true, includePromptText: false, directory }, ui: { showStatus: true, notifyOnEscalation: false } });

describe("PR 6 conservative enforcement (synthetic lifecycle coverage)", () => {
  it.each([
    ["What is JSON?", "low"],
    ["Explain this read-only file", "medium"],
    ["implement this function", "high"],
    ["debug this failing test", "high"],
    ["review this concurrent permission migration", "xhigh"],
  ] as const)("patches the frozen initial routing table for %s", async (text, effort) => {
    const harness = new ExtensionHarness(); await createExtension({ load: config(directory(), "enforce") })(harness.api()); harness.start(); await start(harness, text);
    const original = { instructions: "synthetic", input: [{ role: "user", content: "synthetic" }], tools: [{ type: "function", name: "synthetic" }], tool_choice: "auto", prompt_cache_key: "synthetic-cache", prompt_cache_options: { mode: "explicit" }, prompt_cache_retention: "24h", reasoning: { summary: "none", context: "opaque", encrypted_content: "synthetic" }, previous_response_id: "synthetic-previous", transport: { retries: 2 } };
    const result = harness.request(original);
    expect(result).toBeDefined(); expect(withoutReasoningEffort(result)).toStrictEqual(withoutReasoningEffort(original));
    expect((result as { reasoning: { effort: string } }).reasoning.effort).toBe(effort);
  });

  it("moves from shadow recommendation to exactly one request-local enforce patch", async () => {
    const path = directory(); const harness = new ExtensionHarness(); await createExtension({ load: config(path) })(harness.api()); harness.start();
    const original = { input: "synthetic", prompt_cache_key: "cache", reasoning: { effort: "xhigh", context: "opaque" } };
    await start(harness, "What is JSON?"); expect(harness.request(original)).toBeUndefined(); harness.message("stop", { cacheReadTokens: 4, cacheWriteTokens: 0 }); harness.settled();
    await harness.commands.get("effort")!.handler("enforce", harness.context); await start(harness, "What is JSON?");
    const enforced = harness.request(original)!;
    expect(enforced).not.toBe(original); expect(withoutReasoningEffort(enforced)).toStrictEqual(withoutReasoningEffort(original));
    harness.message("stop", { cacheReadTokens: 4, cacheWriteTokens: 0 });
    const requestRecords = readFileSync(join(path, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { patchStatus: string; cacheReadTokens?: number; cacheWriteTokens?: number });
    expect(requestRecords).toHaveLength(2);
    expect(requestRecords).toEqual(expect.arrayContaining([expect.objectContaining({ patchStatus: "shadow", cacheReadTokens: 4, cacheWriteTokens: 0 }), expect.objectContaining({ patchStatus: "applied", cacheReadTokens: 4, cacheWriteTokens: 0 })]));
    const statuses: string[] = [];
    await harness.commands.get("effort")!.handler("shadow", harness.context); await harness.commands.get("effort")!.handler("status", harness.context); statuses.push(harness.status.get("pi-reap") ?? "");
    expect(statuses.at(-1)).toContain("mode:shadow");
  });

  it.each(["new", "resume", "fork", "reload"] as const)("resets local enforce and max to configured shadow on %s", async (reason) => {
    const harness = new ExtensionHarness(); await createExtension({ load: config(directory()) })(harness.api()); harness.start();
    await harness.commands.get("effort")!.handler("enforce", harness.context); await harness.commands.get("effort")!.handler("max", harness.context);
    harness.shutdown(reason); harness.start(reason); await start(harness, "What is JSON?");
    expect(harness.request({ reasoning: {} })).toBeUndefined();
    expect(harness.status.get("pi-reap")).toContain("mode:shadow"); expect(harness.status.get("pi-reap")).toContain("effort:auto");
  });

  it("registers a Pi-local conflict command with explicit local-not-wire guidance", async () => {
    const harness = new ExtensionHarness(); await createExtension({ load: config(directory()) })(harness.api());
    const messages: string[] = []; const context = { ...harness.context, ui: { ...harness.context.ui, setStatus(_key: string, value: string | undefined) { messages.push(value ?? ""); } } };
    await harness.commands.get("effort-conflict")!.handler("high low", context);
    expect(messages.at(-1)).toContain("place Pi REAP last"); expect(messages.at(-1)).toContain("final-payload logger"); expect(messages.at(-1)).toContain("Local observation"); expect(messages.at(-1)).toContain("not provider wire truth");
    await harness.commands.get("effort-conflict")!.handler("bad", context);
    expect(messages.at(-1)).toContain("local observations only, not provider wire truth");
    expect([...harness.commands.keys()]).toEqual(expect.arrayContaining(["effort", "effort-conflict"]));
  });

  it("leaves unsupported and conflicted requests unchanged as the baseline fallback", async () => {
    for (const ctx of [
      { model: { id: "unsupported", provider: "other", api: "other", reasoning: true } },
      { model: { id: "conflicted", provider: "openai", api: "openai-responses", reasoning: true, thinkingLevelMap: { low: 1 } } },
    ] as const) {
      const harness = new ExtensionHarness(); harness.model = ctx.model; await createExtension({ load: config(directory()) })(harness.api()); harness.start(); await harness.commands.get("effort")!.handler("enforce", harness.context); await start(harness, "What is JSON?");
      const original = { input: "synthetic", reasoning: { effort: "xhigh", context: "opaque" } };
      expect(harness.request(original)).toBeUndefined();
    }
  });
});
