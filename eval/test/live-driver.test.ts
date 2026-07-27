import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  asPostCaptureFailure, authorizationDigest, authorizationEnvelope, cacheEvaluationSystemPrompt, canonicalJson, captureAuthorized, catalogPricing, ceilingRatesMicroUsd, evaluationSystemPrompt, exactTaskIds,
  classifyVerifiedLiveCacheObservability, exactCachePrefixMeasurement, expectedControlHashes, finalizePrivateCapture, finalizeUnsignedArtifact, liveCaps, modelFingerprintForCatalog, planCalls, preflight, privateReviewWorksheet,
  normalizedCacheUsageProvenance, requireExactCachePrefixMeasurement, sanitizedDryRun, sha256, validateCatalog, validatePrivateTasks,
  validateProductionInitialDecision, validateProductionInitialRoutes, verifyPrivateCapture,
  CaptureFailure, PreflightCapabilityError, type CaptureAdapter, type CapturedObservation, type CatalogModel, type ExactCachePrefixMeasurement, type PlannedCall, type PrivateTask,
} from "../runner/live-driver.js";
import { validateSanitizedLiveArtifact, validateTrustedLiveAcceptance } from "../runner/live-acceptance.js";
import { effectiveCostMicros } from "../runner/cost.js";

const validBodies: Readonly<Record<PrivateTask["id"], string>> = {
  "task-simple-query": "prompt-canary task-simple-query: What is two plus two?",
  "task-bounded-read": "prompt-canary task-bounded-read: inspect this file read-only",
  "task-implementation": "prompt-canary task-implementation: implement the change",
  "task-debugging": "prompt-canary task-debugging: debug the failure",
  "task-high-risk-failure": "prompt-canary task-high-risk-failure: security proof",
  "task-other": "prompt-canary task-other: discuss a familiar topic",
};
const tasks: readonly PrivateTask[] = exactTaskIds.map((id) => ({ id, body: validBodies[id], grader: { kind: "exact", expected: `answer-${id}` } }));
const catalog: CatalogModel = {
  id: "openai-codex/gpt-5.4-mini", api: "openai-codex-responses", reasoning: true,
  ratesPerMillion: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  piExecutableSha256: sha256("pi"), piPackageSha256: sha256("package"), piCatalogSha256: sha256("catalog"), piPackageVersion: "0.82.1",
};
const exactPrefixMeasurement: ExactCachePrefixMeasurement = exactCachePrefixMeasurement();
const legacyEnvelope = () => {
  const { cachePrefixMeasurement: _measurement, ...current } = authorizationEnvelope(tasks, catalog, exactPrefixMeasurement);
  return { ...current, schemaVersion: 2 as const };
};
const currentPrivateCapture = (captured: readonly CapturedObservation[]) => {
  const calls = planCalls(tasks); const envelope = authorizationEnvelope(tasks, catalog, exactPrefixMeasurement);
  return {
    schemaVersion: 3 as const, envelope, authorizationDigest: authorizationDigest(envelope), calls, captured,
    cachePrefixMeasurement: exactPrefixMeasurement,
  };
};
const verifiedCurrentCapture = (captured: readonly CapturedObservation[]) => verifyPrivateCapture(currentPrivateCapture(captured), tasks, catalog);
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const effort = (call: PlannedCall) => call.kind === "cache" ? call.effort : call.mode === "fixed-xhigh" ? "xhigh" : call.mode === "fixed-high" ? "high" : call.taskId === "task-simple-query" ? "low" : call.taskId === "task-bounded-read" ? "medium" : call.taskId === "task-high-risk-failure" ? "xhigh" : "high";

function observation(call: PlannedCall, task: PrivateTask, overrides: Partial<CapturedObservation> = {}): CapturedObservation {
  const cache = call.kind === "cache";
  const usage = cache
    ? call.phase === "cold" ? { inputTokens: 5, uncachedInputTokens: 5, outputTokens: 2, reasoningTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 5 }
      : { inputTokens: 5, uncachedInputTokens: 0, outputTokens: 2, reasoningTokens: 1, cacheReadTokens: 5, cacheWriteTokens: 0 }
    : { inputTokens: 5, uncachedInputTokens: 5, outputTokens: 2, reasoningTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const selectedEffort = effort(call); const output = task.grader.expected;
  const baselinePayload = {
    model: "gpt-5.4-mini", input: [{ role: "user", content: task.body }],
    reasoning: { effort: "high", summary: "auto", encrypted_context: "opaque-reasoning-context" },
    prompt_cache_key: call.sessionHash, prompt_cache_retention: "provider-managed",
    include: ["reasoning.encrypted_content"], metadata: { synthetic_fixture: true },
  };
  const appliedPayload = call.kind === "route" && call.mode === "policy-shadow"
    ? structuredClone(baselinePayload)
    : { ...structuredClone(baselinePayload), reasoning: { ...baselinePayload.reasoning, effort: selectedEffort } };
  const accepted = output === task.grader.expected;
  const catalogCostMicros = effectiveCostMicros(usage, catalogPricing);
  const ceilingCostMicros = usage.uncachedInputTokens * ceilingRatesMicroUsd.uncachedInput
    + usage.cacheReadTokens * ceilingRatesMicroUsd.cacheRead + usage.cacheWriteTokens * ceilingRatesMicroUsd.cacheWrite
    + usage.outputTokens * ceilingRatesMicroUsd.output + usage.reasoningTokens * ceilingRatesMicroUsd.reasoning;
  return {
    call, selectedEffort, ...(call.kind === "route" && call.mode === "policy-shadow" ? {} : { appliedEffort: selectedEffort }),
    baselinePayload, appliedPayload, baselinePayloadHash: sha256(canonicalJson(baselinePayload)), appliedPayloadHash: sha256(canonicalJson(appliedPayload)),
    providerRequests: 1, responseAttempts: 1, retries: 0, toolRounds: 0, cacheUsageProvenance: normalizedCacheUsageProvenance(usage), usage, latencyMs: 3,
    providerFingerprint: sha256("openai-codex"), modelFingerprint: modelFingerprintForCatalog(catalog),
    controlHashes: expectedControlHashes(call, task, catalog), output, outputHash: hash(output),
    accepted, criticalFailure: !accepted && task.id === "task-high-risk-failure", catalogCostMicros, ceilingCostMicros, ...overrides,
  };
}
const adapter = (mutate?: (value: CapturedObservation, call: PlannedCall) => CapturedObservation): CaptureAdapter => ({
  estimate: () => ({ inputTokens: 1, uncachedInputTokens: 1, outputTokens: 1, reasoningTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  execute: async (call, task) => { const value = observation(call, task); return mutate ? mutate(value, call) : value; },
});
const jsonClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const stripEffort = (payload: unknown): unknown => {
  const copy = jsonClone(payload) as Record<string, unknown>;
  const reasoning = copy.reasoning as Record<string, unknown>;
  delete reasoning.effort;
  return copy;
};
const withUsage = (value: CapturedObservation, usage: CapturedObservation["usage"]): CapturedObservation => ({
  ...value,
  usage,
  cacheUsageProvenance: normalizedCacheUsageProvenance(usage),
  catalogCostMicros: effectiveCostMicros(usage, catalogPricing),
  ceilingCostMicros: usage.uncachedInputTokens * ceilingRatesMicroUsd.uncachedInput
    + usage.cacheReadTokens * ceilingRatesMicroUsd.cacheRead + usage.cacheWriteTokens * ceilingRatesMicroUsd.cacheWrite
    + usage.outputTokens * ceilingRatesMicroUsd.output + usage.reasoningTokens * ceilingRatesMicroUsd.reasoning,
});

describe("offline PR 6 live-acceptance driver", () => {
  it("plans exactly 24 route rows plus nine cache rows and emits no private text", () => {
    const envelope = authorizationEnvelope(tasks, catalog, exactPrefixMeasurement); const calls = planCalls(tasks);
    const output = JSON.stringify(sanitizedDryRun(calls, envelope, authorizationDigest(envelope), exactPrefixMeasurement));
    expect(calls).toHaveLength(33); expect(calls.filter((call) => call.kind === "route")).toHaveLength(24); expect(calls.filter((call) => call.kind === "cache")).toHaveLength(9);
    expect(new Set(calls.filter((call) => call.kind === "route").map((call) => call.systemPromptHash))).toEqual(new Set([sha256(evaluationSystemPrompt)]));
    expect(new Set(calls.filter((call) => call.kind === "cache").map((call) => call.systemPromptHash))).toEqual(new Set([sha256(cacheEvaluationSystemPrompt)]));
    expect(cacheEvaluationSystemPrompt.trim().split(/\s+/).length).toBeGreaterThan(1_024);
    expect(output).toContain(exactPrefixMeasurement.commonPrefixSha256);
    expect(output).not.toContain("prompt-canary"); expect(output).not.toContain("answer-");
  });

  it("rejects authorization before adapter construction and rejects invalid catalog/tasks", () => {
    let constructed = 0;
    expect(() => preflight(true, undefined, tasks, { ...catalog, api: "wrong" }, exactPrefixMeasurement)).toThrow("authorization digest");
    expect(constructed).toBe(0);
    const digest = authorizationDigest(authorizationEnvelope(tasks, catalog, exactPrefixMeasurement));
    const wrongDigest = `${digest.slice(0, -1)}${digest.endsWith("0") ? "1" : "0"}`;
    expect(() => preflight(true, wrongDigest, tasks, catalog, exactPrefixMeasurement)).toThrow("authorization digest");
    expect(constructed).toBe(0);
    const accepted = preflight(true, digest, tasks, catalog, exactPrefixMeasurement);
    expect(accepted.calls).toHaveLength(33);
    expect(accepted.cachePrefixMeasurement).toStrictEqual(exactPrefixMeasurement);
    expect(authorizationDigest(accepted.envelope)).toBe(digest);
    const staleV2Digest = sha256(canonicalJson(legacyEnvelope()));
    expect(() => preflight(true, staleV2Digest, tasks, catalog, exactPrefixMeasurement)).toThrow("authorization digest");
    expect(() => preflight(true, "3ca072d5aac865e6edca5706287fdc326ac9a59358195fd4f98fc298b2c741b8", tasks, catalog, exactPrefixMeasurement))
      .toThrow("authorization digest");
    const substitutedMeasurement = { ...exactPrefixMeasurement, tokenizerFingerprint: sha256("substituted-tokenizer") };
    expect(() => authorizationEnvelope(tasks, catalog, substitutedMeasurement)).toThrow("pinned prefix boundary");
    const substitutedEnvelope = jsonClone(accepted.envelope);
    substitutedEnvelope.cachePrefixMeasurement.tokenCount += 1;
    expect(() => authorizationDigest(substitutedEnvelope)).toThrow("pinned prefix boundary");
    expect(() => validateCatalog({ ...catalog, ratesPerMillion: { ...catalog.ratesPerMillion, output: 5 } })).toThrow("rates");
    expect(() => validatePrivateTasks([...tasks].reverse())).toThrow("invalid");
    expect(constructed).toBe(0);
    void constructed;
  });

  it("fails closed before authorization when exact provider-compatible prefix tokenization is unavailable", () => {
    const unavailable = {
      schemaVersion: 1 as const, status: "unavailable" as const, code: "provider_compatible_tokenizer_unavailable" as const,
      provider: "openai-codex" as const, model: "openai-codex/gpt-5.4-mini" as const, api: "openai-codex-responses" as const,
    };
    expect(() => preflight(false, undefined, tasks, catalog, unavailable)).toThrow(PreflightCapabilityError);
    expect(() => preflight(true, authorizationDigest(authorizationEnvelope(tasks, catalog, exactPrefixMeasurement)), tasks, catalog, unavailable))
      .toThrow("provider-compatible exact cache-prefix token measurement is unavailable");
    expect(() => requireExactCachePrefixMeasurement({ ...exactPrefixMeasurement, tokenCount: 1 })).toThrow("invalid");
    expect(() => requireExactCachePrefixMeasurement({ ...exactPrefixMeasurement, tokenCount: 1_023 })).toThrow("invalid");
    expect(() => requireExactCachePrefixMeasurement({ ...exactPrefixMeasurement, tokenCount: 1_024 })).toThrow("pinned prefix boundary");
    expect(() => requireExactCachePrefixMeasurement({ ...exactPrefixMeasurement, tokenizerFingerprint: "estimated" })).toThrow("hash");
  });

  it("replays every actual production initial route and rejects mismatched fixtures before authorization", () => {
    expect(() => validateProductionInitialRoutes(tasks)).not.toThrow();
    expect(() => preflight(false, undefined, tasks, catalog, exactPrefixMeasurement)).not.toThrow();
    const mismatches: Readonly<Record<PrivateTask["id"], string>> = {
      "task-simple-query": "prompt-canary neutral statement",
      "task-bounded-read": "prompt-canary neutral statement",
      "task-implementation": "prompt-canary security proof",
      "task-debugging": "prompt-canary security proof",
      "task-high-risk-failure": "prompt-canary neutral statement",
      "task-other": "prompt-canary: What is two plus two?",
    };
    for (const [index, id] of exactTaskIds.entries()) {
      const invalid = tasks.map((task, taskIndex) => taskIndex === index ? { ...task, body: mismatches[id] } : task);
      expect(() => validateProductionInitialRoutes(invalid)).toThrow(`private task ${id} does not match the frozen production initial route`);
      expect(() => preflight(false, undefined, invalid, catalog, exactPrefixMeasurement)).toThrow(`private task ${id} does not match the frozen production initial route`);
    }
  });

  it("rejects a same-effort wrong production class before plan or digest acceptance", () => {
    expect(() => validateProductionInitialDecision("task-debugging", { relation: "new", taskClass: "unknown", selectedEffort: "high" }))
      .toThrow("task-debugging does not match the frozen production initial route (unknown/high selected; implementation/high required)");
    const invalid = tasks.map((task) => task.id === "task-bounded-read" ? { ...task, body: "prompt-canary neutral statement" } : task);
    const digestForInvalidPlan = authorizationDigest(authorizationEnvelope(invalid, catalog, exactPrefixMeasurement));
    expect(() => preflight(true, digestForInvalidPlan, invalid, catalog, exactPrefixMeasurement)).toThrow("task-bounded-read does not match the frozen production initial route");
  });

  it("deep-rejects forged, reordered, missing, and extra plans before factory use", async () => {
    const calls = planCalls(tasks); let constructed = 0; const factory = () => { constructed += 1; return adapter(); };
    await expect(captureAuthorized(calls.slice(0, 32), tasks, factory)).rejects.toMatchObject({ code: "invalid_plan", completedCalls: 0 });
    await expect(captureAuthorized([...calls, calls[0]!], tasks, factory)).rejects.toMatchObject({ code: "invalid_plan", completedCalls: 0 });
    await expect(captureAuthorized([calls[1]!, calls[0]!, ...calls.slice(2)], tasks, factory)).rejects.toMatchObject({ code: "invalid_plan", completedCalls: 0 });
    await expect(captureAuthorized(calls.map((call, index) => index === 0 ? { ...call, ordinal: 9 } : call), tasks, factory)).rejects.toMatchObject({ code: "invalid_plan", completedCalls: 0 });
    await expect(captureAuthorized(calls.map((call, index) => index === 24 ? { ...call, systemPromptHash: sha256("forged") } : call), tasks, factory)).rejects.toMatchObject({ code: "invalid_plan", completedCalls: 0 });
    expect(constructed).toBe(0);
  });

  it("executes exactly 33 mocked calls and aborts before another call on retry, cap, or failure", async () => {
    const calls = planCalls(tasks); let invoked = 0;
    const captured = await captureAuthorized(calls, tasks, () => ({ ...adapter(), execute: async (call, task) => { invoked += 1; return observation(call, task); } }));
    expect(invoked).toBe(33); expect(captured).toHaveLength(33);
    invoked = 0;
    await expect(captureAuthorized(calls, tasks, () => ({ ...adapter(), execute: async (call, task) => { invoked += 1; const value = observation(call, task); return invoked === 7 ? { ...value, retries: 1 } : value; } }))).rejects.toMatchObject({ code: "cap_rejected", completedCalls: 6 });
    expect(invoked).toBe(7);
    let executed = 0;
    await expect(captureAuthorized(calls, tasks, () => ({ estimate: () => ({ inputTokens: liveCaps.maxInputTokens + 1, uncachedInputTokens: liveCaps.maxInputTokens + 1, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), execute: async (call, task) => { executed += 1; return observation(call, task); } }))).rejects.toMatchObject({ code: "cap_rejected", completedCalls: 0 });
    expect(executed).toBe(0);
    invoked = 0;
    await expect(captureAuthorized(calls, tasks, () => ({ ...adapter(), execute: async (call, task) => { invoked += 1; if (invoked === 4) throw new Error("private-canary"); return observation(call, task); } }))).rejects.toMatchObject({ code: "adapter_call", completedCalls: 3 });
    expect(invoked).toBe(4);
  });

  it("preserves every canonical payload field except reasoning.effort in all execution modes", async () => {
    const calls = planCalls(tasks);
    const captured = await captureAuthorized(calls, tasks, () => adapter());
    for (const index of [0, 6, 12, 18, 24]) {
      const item = captured[index]!;
      expect(stripEffort(item.appliedPayload)).toStrictEqual(stripEffort(item.baselinePayload));
      expect((item.appliedPayload as Record<string, unknown>).prompt_cache_retention).toBe("provider-managed");
      expect(((item.appliedPayload as Record<string, unknown>).reasoning as Record<string, unknown>).encrypted_context).toBe("opaque-reasoning-context");
    }
    await expect(captureAuthorized(calls, tasks, () => adapter((value, call) => call.ordinal === 1
      ? {
          ...value,
          appliedPayload: { ...(value.appliedPayload as Record<string, unknown>), max_output_tokens: 300 },
          appliedPayloadHash: sha256(canonicalJson({ ...(value.appliedPayload as Record<string, unknown>), max_output_tokens: 300 })),
        }
      : value))).rejects.toMatchObject({ code: "observation_rejected", completedCalls: 0 });
  });

  it("reports actual completed calls at call 1, 17, 33, and an observed cap edge", async () => {
    const calls = planCalls(tasks);
    for (const [failAt, completed] of [[1, 0], [17, 16], [33, 32]] as const) {
      let invoked = 0;
      const failure = captureAuthorized(calls, tasks, () => ({
        ...adapter(),
        execute: async (call, task) => {
          invoked += 1;
          if (invoked === failAt) throw new Error("private failure detail");
          return observation(call, task);
        },
      }));
      await expect(failure).rejects.toBeInstanceOf(CaptureFailure);
      await expect(failure).rejects.toMatchObject({ code: "adapter_call", completedCalls: completed });
      expect(invoked).toBe(failAt);
    }
    let invoked = 0;
    await expect(captureAuthorized(calls, tasks, () => ({
      ...adapter(),
      execute: async (call, task) => {
        invoked += 1;
        const value = observation(call, task);
        return invoked === 17 ? withUsage(value, { ...value.usage, outputTokens: liveCaps.maxOutputTokens }) : value;
      },
    }))).rejects.toMatchObject({ code: "cap_rejected", completedCalls: 16 });
    expect(invoked).toBe(17);
  });

  it("preserves observed metrics/cache rows, grades privately, and emits an unsigned artifact only", async () => {
    const calls = planCalls(tasks); const captured = await captureAuthorized(calls, tasks, () => adapter());
    const artifact = finalizeUnsignedArtifact(verifiedCurrentCapture(captured), tasks);
    expect(artifact.runs[0]!.usage).toStrictEqual(captured[0]!.usage);
    expect(artifact.cacheCrossover[0]!.samples[0]!.usage.cacheWriteTokens).toBe(5);
    expect(artifact.cacheCrossover[0]!.samples[1]!.usage.cacheReadTokens).toBe(5);
    expect(JSON.stringify(artifact)).not.toContain("prompt-canary"); expect(JSON.stringify(artifact)).not.toContain("answer-");
    expect(() => validateSanitizedLiveArtifact(artifact, catalogPricing)).not.toThrow();
    expect(() => validateTrustedLiveAcceptance(artifact, {})).toThrow("unknown");
    expect(privateReviewWorksheet(captured, tasks)).toEqual([]);
  });

  it("preserves an all-zero complete capture and classifies normalized-only evidence as OBSERVABILITY_UNAVAILABLE", async () => {
    const calls = planCalls(tasks);
    const captured = await captureAuthorized(calls, tasks, () => adapter());
    const noCache = captured.map((item) => item.call.kind === "cache"
      ? withUsage(item, {
          inputTokens: item.usage.inputTokens,
          uncachedInputTokens: item.usage.inputTokens,
          outputTokens: item.usage.outputTokens,
          reasoningTokens: item.usage.reasoningTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        })
      : item);
    const verified = verifiedCurrentCapture(noCache);
    expect(() => finalizeUnsignedArtifact(verified, tasks)).not.toThrow();
    expect(classifyVerifiedLiveCacheObservability(verified)).toBe("OBSERVABILITY_UNAVAILABLE");
    expect(asPostCaptureFailure(new Error("private detail"))).toMatchObject({
      code: "post_capture_finalization_failed", phase: "post_capture", completedCalls: 33,
    });
    expect(() => new CaptureFailure("adapter_call", 33)).toThrow("phase");
    expect(() => new CaptureFailure("cache_crossover_no_cache_read", 32)).toThrow("phase");
  });

  it("rejects a positive-warm-read schema-v2 capture at the CLI verify/finalize boundary", async () => {
    const calls = planCalls(tasks);
    const captured = await captureAuthorized(calls, tasks, () => adapter());
    expect(captured.filter((item) => item.call.kind === "cache" && item.call.phase === "warm")
      .every((item) => item.usage.cacheReadTokens > 0)).toBe(true);
    const legacyCaptured = captured.map(({ cacheUsageProvenance: _provenance, ...item }) => item);
    const envelope = legacyEnvelope();
    const legacy = { schemaVersion: 2 as const, envelope, authorizationDigest: sha256(canonicalJson(envelope)), calls, captured: legacyCaptured };
    const verifiedLegacy = verifyPrivateCapture(legacy, tasks, catalog);
    expect(verifiedLegacy.schemaVersion).toBe(2);
    expect(() => finalizeUnsignedArtifact(verifiedLegacy, tasks)).toThrow("legacy_or_missing_exact_prefix_measurement");
    expect(() => finalizePrivateCapture(legacy, tasks, catalog)).toThrow("legacy_or_missing_exact_prefix_measurement");
    try {
      finalizePrivateCapture(legacy, tasks, catalog);
    } catch (error) {
      expect(error).toMatchObject({ code: "legacy_or_missing_exact_prefix_measurement", phase: "post_capture", completedCalls: 33 });
    }
  });

  it("revalidates the complete private capture and rejects stale or forged evidence offline", async () => {
    const calls = planCalls(tasks);
    const captured = await captureAuthorized(calls, tasks, () => adapter());
    const envelope = legacyEnvelope();
    const legacyCaptured = captured.map(({ cacheUsageProvenance: _provenance, ...item }) => item);
    const privateCapture = { schemaVersion: 2 as const, envelope, authorizationDigest: sha256(canonicalJson(envelope)), calls, captured: legacyCaptured };
    const legacyVerified = verifyPrivateCapture(privateCapture, tasks, catalog);
    expect(legacyVerified.schemaVersion).toBe(2);
    expect(legacyVerified.captured[0]!.cacheUsageProvenance).toBeUndefined();
    expect(legacyVerified.cachePrefixMeasurement).toBeUndefined();
    const currentEnvelope = authorizationEnvelope(tasks, catalog, exactPrefixMeasurement);
    const currentCapture = {
      schemaVersion: 3 as const, envelope: currentEnvelope, authorizationDigest: authorizationDigest(currentEnvelope), calls, captured,
      cachePrefixMeasurement: exactPrefixMeasurement,
    };
    expect(() => verifyPrivateCapture(currentCapture, tasks, catalog)).not.toThrow();
    const forgedProvenance = jsonClone(currentCapture);
    forgedProvenance.captured[0]!.cacheUsageProvenance!.normalizedCacheReadTokens += 1;
    expect(() => verifyPrivateCapture(forgedProvenance, tasks, catalog)).toThrow("provenance");
    const missingProvenance = jsonClone(currentCapture);
    delete missingProvenance.captured[0]!.cacheUsageProvenance;
    expect(() => verifyPrivateCapture(missingProvenance, tasks, catalog)).toThrow("unknown, missing");
    const forgedMeasurement = jsonClone(currentCapture);
    forgedMeasurement.cachePrefixMeasurement.commonPrefixSha256 = sha256("forged-prefix");
    forgedMeasurement.cachePrefixMeasurement.tokenizerFingerprint = "not-a-hash";
    expect(() => verifyPrivateCapture(forgedMeasurement, tasks, catalog)).toThrow("hash");

    const attacks: unknown[] = [];
    const staleEnvelope = jsonClone(privateCapture); staleEnvelope.envelope.sourceFingerprint = sha256("stale-source"); attacks.push(staleEnvelope);
    const badDigest = jsonClone(privateCapture); badDigest.authorizationDigest = sha256("forged-digest"); attacks.push(badDigest);
    const reorderedCalls = jsonClone(privateCapture); [reorderedCalls.calls[0], reorderedCalls.calls[1]] = [reorderedCalls.calls[1]!, reorderedCalls.calls[0]!]; attacks.push(reorderedCalls);
    const reorderedObservations = jsonClone(privateCapture); [reorderedObservations.captured[0], reorderedObservations.captured[1]] = [reorderedObservations.captured[1]!, reorderedObservations.captured[0]!]; attacks.push(reorderedObservations);
    const forgedUsage = jsonClone(privateCapture); forgedUsage.captured[0]!.usage.outputTokens += 1; attacks.push(forgedUsage);
    const forgedOutputHash = jsonClone(privateCapture); forgedOutputHash.captured[0]!.outputHash = sha256("forged"); attacks.push(forgedOutputHash);
    const forgedControl = jsonClone(privateCapture); forgedControl.captured[0]!.controlHashes.transportHash = sha256("websocket"); attacks.push(forgedControl);
    const forgedGrade = jsonClone(privateCapture); forgedGrade.captured[0]!.accepted = false; attacks.push(forgedGrade);
    const forgedCost = jsonClone(privateCapture); forgedCost.captured[0]!.catalogCostMicros += 1; attacks.push(forgedCost);
    const duplicateCache = jsonClone(privateCapture); duplicateCache.captured[24] = duplicateCache.captured[25]!; attacks.push(duplicateCache);
    for (const attack of attacks) expect(() => verifyPrivateCapture(attack, tasks, catalog)).toThrow();

    const alteredTasks = jsonClone(tasks); alteredTasks[0]!.body += "-replacement";
    expect(() => verifyPrivateCapture(privateCapture, alteredTasks, catalog)).toThrow("envelope");
    expect(() => verifyPrivateCapture(privateCapture, tasks, { ...catalog, piCatalogSha256: sha256("changed-runtime") })).toThrow("envelope");
  });

  it("requires a closed review and fixed fixture binding for an observed under-route", async () => {
    const calls = planCalls(tasks);
    const captured = await captureAuthorized(calls, tasks, () => adapter((value, call) => call.kind === "route" && call.taskId === "task-simple-query" && call.mode === "policy-enforce"
      ? { ...value, output: "rejected", outputHash: hash("rejected"), accepted: false } : value));
    expect(privateReviewWorksheet(captured, tasks)).toHaveLength(1);
    const verified = verifiedCurrentCapture(captured);
    expect(() => finalizeUnsignedArtifact(verified, tasks)).toThrow("closed private review");
    expect(() => finalizeUnsignedArtifact(verified, tasks, [{
      runId: "task-simple-query:policy-enforce", taskId: "task-simple-query", reviewer: "independent", reviewedAt: "2026-07-26T00:00:00Z",
      acceptance: "reject", rationale: "private evidence reviewed", fixtureCode: "fixed-noncritical-simple-query", fixtureHash: hash("wrong"),
    }])).toThrow("fixture binding");
  });
});
