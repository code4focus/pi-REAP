import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExtension } from "../../src/index.js";
import { ExtensionHarness, type SyntheticContext } from "./extension-harness.js";

const directories: string[] = [];
const ctx: SyntheticContext = { model: { id: "synthetic-model", provider: "openai", api: "openai-responses", reasoning: true } };
const directory = () => { const path = mkdtempSync(join(tmpdir(), "pi-reap-pr4-")); directories.push(path); return path; };
const records = (path: string, file: string) => readFileSync(join(path, file), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("telemetry and shadow mode (synthetic lifecycle coverage)", () => {
  it("registers the Pi-local effort command with status through command context UI", () => {
    const harness = new ExtensionHarness(); createExtension({ telemetryDirectory: directory() })(harness);
    const command = harness.commands.get("effort"); const statuses: string[] = [];
    expect(command?.description).toContain("local effort");
    void command?.handler("status", { ui: { setStatus(key, text) { statuses.push(`${key}:${text}`); } } });
    expect(statuses).toHaveLength(1); expect(statuses[0]).toContain("effort-router:effort:auto");
  });

  it("records correlated redacted decision, request, and epoch records", () => {
    const path = directory(); const harness = new ExtensionHarness(); createExtension({ telemetryDirectory: path, sessionId: "synthetic-session" })(harness);
    harness.emit("input", { ctx, input: { text: "Do not persist this secret prompt", source: "interactive" } });
    harness.emit("before_agent_start", { ctx });
    const result = harness.emit("before_provider_request", { ctx, request: { payload: { input: "secret prompt", tools: [{ name: "private" }], reasoning: { summary: "none" } } } });
    harness.emit("message_end", { ctx, message: { role: "assistant", stopReason: "stop", usage: { inputTokens: 11, outputTokens: 7, reasoningTokens: 3 } } }); harness.emit("agent_settled", { ctx });
    expect((result.request.payload as { reasoning: { effort: string } }).reasoning.effort).toBe("high");
    const serialized = readFileSync(join(path, "decisions.jsonl"), "utf8") + readFileSync(join(path, "requests.jsonl"), "utf8") + readFileSync(join(path, "epochs.jsonl"), "utf8");
    expect(serialized).not.toContain("Do not persist this secret prompt"); expect(serialized).not.toContain("secret prompt"); expect(serialized).not.toContain("private");
    const [decision] = records(path, "decisions.jsonl"); const [request] = records(path, "requests.jsonl"); const [epoch] = records(path, "epochs.jsonl");
    expect(decision).toMatchObject({ schemaVersion: 1, mode: "enforce", promptChars: 33 });
    expect(request).toMatchObject({ schemaVersion: 1, requestIndex: 1, inputTokens: 11, outputTokens: 7, reasoningTokens: 3, stopReason: "stop", patchStatus: "applied" });
    expect(epoch).toMatchObject({ schemaVersion: 1, requestCount: 1, status: "settled" });
    expect(harness.setThinkingLevelCalls).toEqual([]); expect(harness.registerToolCalls).toEqual([]);
  });

  it("keeps the provider payload baseline in shadow while recording its recommendation separately", () => {
    const path = directory(); const harness = new ExtensionHarness(); createExtension({ telemetryDirectory: path })(harness);
    void harness.commands.get("effort")?.handler("shadow", { ui: { setStatus() {} } });
    harness.emit("input", { ctx, input: { text: "What is JSON?" } }); harness.emit("before_agent_start", { ctx });
    const original = { input: "synthetic", reasoning: { effort: "xhigh", context: "opaque" } };
    const result = harness.emit("before_provider_request", { ctx, request: { payload: original } });
    expect(result.request.payload).toBe(original);
    harness.emit("message_end", { ctx, stopReason: "stop" });
    const [request] = records(path, "requests.jsonl");
    expect(request).toMatchObject({ patchStatus: "shadow", originalEffort: "xhigh", appliedEffort: "xhigh" });
    expect(JSON.stringify(request)).not.toContain("opaque");
    expect(harness.setThinkingLevelCalls).toEqual([]);
  });

  it("does not invent an applied effort for an unknown shadow baseline", () => {
    const path = directory(); const harness = new ExtensionHarness(); createExtension({ telemetryDirectory: path })(harness);
    void harness.commands.get("effort")?.handler("shadow", { ui: { setStatus() {} } });
    harness.emit("input", { ctx, input: { text: "What is JSON?" } }); harness.emit("before_agent_start", { ctx });
    const original = { input: "synthetic", reasoning: { summary: "none" } };
    expect(harness.emit("before_provider_request", { ctx, request: { payload: original } }).request.payload).toBe(original);
    harness.emit("message_end", { ctx, message: { role: "assistant", stopReason: "stop" } });
    const [decision] = records(path, "decisions.jsonl"); const [request] = records(path, "requests.jsonl");
    expect(decision?.recommendedEffort).toBe("low"); expect(decision?.appliedEffort).toBeUndefined(); expect(request?.appliedEffort).toBeUndefined();
  });

  it("continues routing when the telemetry directory is deleted", () => {
    const path = directory(); const harness = new ExtensionHarness(); createExtension({ telemetryDirectory: path })(harness);
    harness.emit("input", { ctx, input: { text: "What is JSON?" } }); harness.emit("before_agent_start", { ctx });
    rmSync(path, { recursive: true, force: true });
    expect(() => harness.emit("before_provider_request", { ctx, request: { payload: { reasoning: {} } } })).not.toThrow();
    expect(() => harness.emit("message_end", { ctx, stopReason: "stop" })).not.toThrow();
  });
});
