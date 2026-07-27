import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalPayloadHash,
  diagnoseLaterEffortMutator,
  patchProviderPayload,
  patchReasoningEffort,
  resolveProviderEffort,
  supportsEffortRouting,
  withoutReasoningEffort,
} from "../../src/provider/patch.js";

const codexModel = { api: "openai-codex-responses", reasoning: true };
const responsesModel = { api: "openai-responses", reasoning: true };

const fixture = async (relativePath: string): Promise<unknown> => JSON.parse(await readFile(
  fileURLToPath(new URL(`../fixtures/${relativePath}`, import.meta.url)), "utf8",
)) as unknown;

describe("provider patch layer", () => {
  it("recognizes exactly the two supported reasoning APIs", () => {
    expect(supportsEffortRouting(codexModel)).toBe(true);
    expect(supportsEffortRouting(responsesModel)).toBe(true);
    expect(supportsEffortRouting({ api: "azure-openai-responses", reasoning: true })).toBe(false);
    expect(supportsEffortRouting({ api: "openai-responses", reasoning: false })).toBe(false);
    expect(supportsEffortRouting(undefined)).toBe(false);
  });

  it("maps provider effort only when the mapping is valid", () => {
    expect(resolveProviderEffort({ ...codexModel, thinkingLevelMap: { high: "deep" } }, "high")).toBe("deep");
    expect(resolveProviderEffort({ ...codexModel, thinkingLevelMap: { high: null } }, "high")).toBeUndefined();
    expect(resolveProviderEffort({ ...codexModel, thinkingLevelMap: { high: null, xhigh: "deeper" } }, "high")).toBe("deeper");
    expect(resolveProviderEffort({ ...codexModel, thinkingLevelMap: { high: 1 } }, "high")).toBeUndefined();
    expect(resolveProviderEffort({ api: "other", reasoning: true }, "high")).toBeUndefined();
  });

  it.each([
    "openai-codex-responses/first-turn.json",
    "openai-codex-responses/tool-continuation.json",
    "openai-codex-responses/reasoning-replay.json",
    "openai-codex-responses/compacted-session.json",
    "openai-responses/first-turn.json",
    "openai-responses/tool-continuation.json",
    "openai-responses/reasoning-replay.json",
  ])("preserves every fixture field except reasoning.effort: %s", async (path) => {
    const original = await fixture(path);
    const patched = patchProviderPayload(path.startsWith("openai-codex") ? codexModel : responsesModel, original, "low");
    expect(withoutReasoningEffort(patched)).toStrictEqual(withoutReasoningEffort(original));
    expect(canonicalPayloadHash(withoutReasoningEffort(patched))).toBe(canonicalPayloadHash(withoutReasoningEffort(original)));
    expect((patched as { reasoning: { effort: string } }).reasoning.effort).toBe("low");
  });

  it("leaves unknown, invalid, and conflicted payloads unchanged by reference", () => {
    for (const payload of [undefined, null, [], "request", { reasoning: null }, { reasoning: { effort: 4 } }]) {
      expect(patchProviderPayload(codexModel, payload, "low")).toBe(payload);
    }
    const payload = { reasoning: { effort: "high" } };
    expect(patchProviderPayload({ api: "other", reasoning: true }, payload, "low")).toBe(payload);
    expect(patchReasoningEffort(payload, "")).toBe(payload);
  });

  it("reports later effort-mutator conflicts without claiming wire truth", () => {
    expect(diagnoseLaterEffortMutator("high", "high")).toBeUndefined();
    expect(diagnoseLaterEffortMutator(undefined, "low")).toBeUndefined();
    expect(diagnoseLaterEffortMutator("high", "low")).toEqual({
      code: "later_effort_mutator",
      expectedEffort: "high",
      observedEffort: "low",
      message: expect.stringContaining("place Pi REAP last"),
    });
  });

  it("creates only the requested effort when supported payload reasoning is absent", () => {
    const original = {
      input: [{ role: "user", content: "synthetic" }],
      prompt_cache_key: "synthetic-cache-key",
      transport: { retry: 1 },
    };
    const patched = patchProviderPayload(codexModel, original, "low");
    expect(patched).toEqual({ ...original, reasoning: { effort: "low" } });
    const { reasoning: _reasoning, ...preserved } = patched as typeof original & { reasoning: unknown };
    expect(preserved).toStrictEqual(original);
    expect(canonicalPayloadHash(preserved)).toBe(canonicalPayloadHash(original));
  });

  it("has an exhaustive deterministic preservation property across JSON-like payloads", () => {
    let seed = 0x5eed1234;
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    for (let index = 0; index < 200; index += 1) {
      const payload = {
        instructions: `synthetic-${next()}`,
        input: [{ role: "user", content: `synthetic-${next()}` }],
        tools: [{ type: "function", name: `tool_${next()}` }],
        tool_choice: "auto",
        prompt_cache_key: `cache-${next()}`,
        prompt_cache_options: { retention: "24h", salt: next() },
        prompt_cache_retention: "24h",
        previous_response_id: `resp-${next()}`,
        reasoning: { effort: "medium", summary: `summary-${next()}`, context: `encrypted-${next()}` },
        transport: { retry: next() % 3 },
      };
      const patched = patchReasoningEffort(payload, "xhigh");
      expect(withoutReasoningEffort(patched)).toStrictEqual(withoutReasoningEffort(payload));
      expect(canonicalPayloadHash(withoutReasoningEffort(patched))).toBe(canonicalPayloadHash(withoutReasoningEffort(payload)));
    }
  });

  it("marks every fixture as synthetic and sanitized", async () => {
    for (const path of ["openai-codex-responses/first-turn.json", "openai-codex-responses/tool-continuation.json", "openai-codex-responses/reasoning-replay.json", "openai-codex-responses/compacted-session.json", "openai-responses/first-turn.json", "openai-responses/tool-continuation.json", "openai-responses/reasoning-replay.json"]) {
      const value = await fixture(path) as { fixture_provenance: string };
      expect(value.fixture_provenance).toContain("synthetic sanitized");
      expect(value.fixture_provenance).toContain("not a captured real Pi request");
    }
  });
});
