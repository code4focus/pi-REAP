import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtension, type PiExtensionHost } from "../../src/index.js";
import { withoutReasoningEffort } from "../../src/provider/patch.js";
import { ExtensionHarness, type SyntheticContext } from "./extension-harness.js";

const ctx: SyntheticContext = { model: { id: "synthetic", provider: "openai", api: "openai-responses", reasoning: true } };
const extension = (pi: PiExtensionHost) => createExtension({ telemetryDirectory: mkdtempSync(join(tmpdir(), "pi-reap-lifecycle-")) })(pi);

describe("typed lifecycle adapter", () => {
  it.each(["continue", "fix it"])("routes a %s after session resume to xhigh and patches request-locally", (text) => {
    const harness = new ExtensionHarness(); extension(harness);
    harness.emit("session_start", { reason: "resume" });
    harness.emit("input", { ctx, input: { text } }); harness.emit("before_agent_start", { ctx });
    const original = { input: [{ role: "user", content: "synthetic" }], reasoning: { summary: "none" } };
    const result = harness.emit("before_provider_request", { ctx, request: { payload: original } });
    expect(withoutReasoningEffort(result.request.payload)).toStrictEqual(withoutReasoningEffort(original));
    expect((result.request.payload as { reasoning: { effort: string } }).reasoning.effort).toBe("xhigh");
  });

  it("keeps normal startup simple input low and an active continuation high", () => {
    const harness = new ExtensionHarness(); extension(harness);
    harness.emit("session_start", { reason: "startup" });
    harness.emit("input", { ctx, input: { text: "What is JSON?" } }); harness.emit("before_agent_start", { ctx });
    const first = harness.emit("before_provider_request", { ctx, request: { payload: { reasoning: {} } } });
    expect((first.request.payload as { reasoning: { effort: string } }).reasoning.effort).toBe("low");
    harness.emit("input", { ctx, input: { text: "continue" } }); harness.emit("before_agent_start", { ctx });
    const second = harness.emit("before_provider_request", { ctx, request: { payload: { reasoning: {} } } });
    expect((second.request.payload as { reasoning: { effort: string } }).reasoning.effort).toBe("high");
  });
  it("retains input only through input/start, then patches exactly reasoning.effort", () => {
    const harness = new ExtensionHarness(); extension(harness);
    harness.emit("input", { ctx, input: { text: "What is JSON?", source: "interactive" } });
    harness.emit("before_agent_start", { ctx });
    const original = { input: [{ role: "user", content: "synthetic" }], prompt_cache_key: "synthetic-cache", reasoning: { summary: "none" } };
    const result = harness.emit("before_provider_request", { ctx, request: { payload: original } });
    expect(withoutReasoningEffort(result.request.payload)).toStrictEqual(withoutReasoningEffort(original));
    expect((result.request.payload as { reasoning: { effort: string } }).reasoning.effort).toBe("low");
  });

  it("keeps generated unknown payloads baseline-safe through reproducible adapter events", () => {
    const first = generatedUnknowns(0x5eed1234, 96);
    expect(generatedUnknowns(0x5eed1234, 96)).toStrictEqual(first);
    for (const [index, payload] of first.entries()) {
      const harness = new ExtensionHarness(); extension(harness);
      harness.emit("input", { ctx, input: { text: "What is JSON?" } }); harness.emit("before_agent_start", { ctx });
      const model = modelVariants[index % modelVariants.length]!;
      const event = { ctx: { model }, request: { payload } };
      expect(() => harness.emit("before_provider_request", event)).not.toThrow();
      const result = harness.emit("before_provider_request", event);
      if (result.request.payload !== payload) {
        expect((result.request.payload as { reasoning?: { effort?: unknown } }).reasoning?.effort).toBe("low");
        expect(isReasoningOnlyPatch(payload, result.request.payload)).toBe(true);
      } else expect(result.request.payload).toBe(payload);
    }
  });
});

const modelVariants: readonly SyntheticContext["model"][] = [
  { id: "supported", provider: "openai", api: "openai-responses", reasoning: true },
  { id: "codex", provider: "openai", api: "openai-codex-responses", reasoning: true },
  { id: "unsupported-api", provider: "other", api: "other", reasoning: true },
  { id: "reasoning-off", provider: "openai", api: "openai-responses", reasoning: false },
  { id: "invalid-map", provider: "openai", api: "openai-responses", reasoning: true, thinkingLevelMap: { low: 1 } },
];

function generatedUnknowns(seed: number, count: number): unknown[] {
  let state = seed >>> 0;
  const next = (): number => { state = (state * 1664525 + 1013904223) >>> 0; return state; };
  const value = (depth: number): unknown => {
    const tag = next() % (depth > 2 ? 6 : 10);
    if (tag === 0) return undefined;
    if (tag === 1) return null;
    if (tag === 2) return next() % 2 === 0;
    if (tag === 3) return next() % 2 === 0 ? next() : `synthetic-${next()}`;
    if (tag === 4) return [value(depth + 1), value(depth + 1)];
    if (tag === 5) return { nested: value(depth + 1), cache: `synthetic-${next()}` };
    if (tag === 6) return { reasoning: null, input: value(depth + 1) };
    if (tag === 7) return { reasoning: { effort: next() % 2 === 0 ? next() : "medium", context: value(depth + 1) } };
    if (tag === 8) return { reasoning: [value(depth + 1)], tools: value(depth + 1) };
    return { input: value(depth + 1), transport: { retry: next() % 3 }, prompt_cache_key: `synthetic-${next()}` };
  };
  return Array.from({ length: count }, () => value(0));
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function isReasoningOnlyPatch(original: unknown, patched: unknown): boolean {
  if (!record(original) || !record(patched) || !record(patched.reasoning) || typeof patched.reasoning.effort !== "string") return false;
  if (record(original.reasoning)) return JSON.stringify(withoutReasoningEffort(original)) === JSON.stringify(withoutReasoningEffort(patched));
  const { reasoning: _reasoning, ...withoutReasoning } = patched;
  return JSON.stringify(original) === JSON.stringify(withoutReasoning);
}
