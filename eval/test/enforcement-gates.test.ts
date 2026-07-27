import { describe, expect, it } from "vitest";
import { syntheticManifest } from "../corpus/manifest.js";
import { syntheticCacheCrossover, type CacheCrossoverGroup } from "../runner/cache-crossover.js";
import { assertEnforcementGates, assessEnforcementGates } from "../runner/gates.js";
import { runEvaluation } from "../runner/run.js";
import type { EvaluationExecutor } from "../runner/types.js";

const executor: EvaluationExecutor = { execute: async (task, request) => {
  const selectedEffort = request.requestedEffort ?? (task.id === "regression-under-routing-review" ? "low" : task.taskClass === "high_risk" || task.taskClass === "architecture" ? "xhigh" : task.taskClass === "implementation" || task.taskClass === "debugging" || task.taskClass === "continuation" ? "high" : task.taskClass === "bounded_read" ? "medium" : "low");
  return { output: task.grader.expected, selectedEffort, providerRequests: 1, toolRounds: 1, retries: 0, usage: { inputTokens: 20, uncachedInputTokens: 10, outputTokens: 2, reasoningTokens: 3, cacheReadTokens: 10, cacheWriteTokens: 1 }, latencyMs: 4 };
} };

describe("PR 6 mandatory enforcement-gate machinery (synthetic evidence)", () => {
  it("requires both shadow and enforce comparisons, cache measurements, and synthetic contract dispositions without calling them human reviews", async () => {
    const runs = await runEvaluation(syntheticManifest, executor, { corpusMode: "regression", repetitions: 1 });
    const underRoute = runs.find((run) => run.mode === "policy-enforce" && run.taskId === "regression-under-routing-review")!;
    const reviews = [{ kind: "synthetic_contract" as const, runId: underRoute.id, taskId: underRoute.taskId, fixtureHash: "a".repeat(64) }];
    const evidence = assessEnforcementGates(syntheticManifest, runs, syntheticCacheCrossover, reviews);
    expect(evidence).toStrictEqual({ highRiskProtected: true, codingHasNoCriticalFailure: true, regressionWithinAllowance: true, requestCountsNotAmplified: true, cacheBehaviorNotAmplified: true, cacheCrossoverComplete: true, everyUnderRouteReviewed: true });
    expect(() => assertEnforcementGates(syntheticManifest, runs, syntheticCacheCrossover, reviews)).not.toThrow();
  });

  it("rejects missing review evidence for a fixed under-routing case", async () => {
    const runs = await runEvaluation(syntheticManifest, executor, { corpusMode: "regression", repetitions: 1 });
    expect(() => assertEnforcementGates(syntheticManifest, runs, syntheticCacheCrossover, [])).toThrow("everyUnderRouteReviewed");
  });

  it("fails closed for fabricated reviews, incomplete high-risk rows, and unmatched baseline subsets", async () => {
    const runs = await runEvaluation(syntheticManifest, executor, { corpusMode: "regression", repetitions: 1 });
    const underRoute = runs.find((run) => run.mode === "policy-enforce" && run.taskId === "regression-under-routing-review")!;
    const review = { kind: "synthetic_contract" as const, runId: underRoute.id, taskId: underRoute.taskId, fixtureHash: "a".repeat(64) };
    expect(() => assertEnforcementGates(syntheticManifest, runs, syntheticCacheCrossover, [{ ...review, taskId: "fabricated-task" }])).toThrow("everyUnderRouteReviewed");
    expect(() => assertEnforcementGates(syntheticManifest, runs, syntheticCacheCrossover, [{ ...review, runId: "fabricated-run" }])).toThrow("everyUnderRouteReviewed");
    expect(() => assertEnforcementGates(syntheticManifest, runs.filter((run) => !(run.taskClass === "high_risk" && run.mode === "policy-enforce")), syntheticCacheCrossover, [review])).toThrow("missing or extra");
    expect(() => assertEnforcementGates(syntheticManifest, runs.filter((run) => !(run.taskId === underRoute.taskId && run.mode === "fixed-xhigh")), syntheticCacheCrossover, [review])).toThrow("missing or extra");
    expect(() => assertEnforcementGates(syntheticManifest, [...runs, runs[0]!], syntheticCacheCrossover, [review])).toThrow("duplicate regression matrix row");
    expect(() => assertEnforcementGates(syntheticManifest, runs.map((run) => run === runs[0] ? { ...run, taskClass: "unknown" } : run), syntheticCacheCrossover, [review])).toThrow("unexpected regression run");
  });

  it("rejects duplicate or mislabeled cache matrix rows, including all-low efforts", async () => {
    const runs = await runEvaluation(syntheticManifest, executor, { corpusMode: "regression", repetitions: 1 });
    const underRoute = runs.find((run) => run.mode === "policy-enforce" && run.taskId === "regression-under-routing-review")!;
    const reviews = [{ kind: "synthetic_contract" as const, runId: underRoute.id, taskId: underRoute.taskId, fixtureHash: "a".repeat(64) }];
    const cloned = (): CacheCrossoverGroup[] => structuredClone(syntheticCacheCrossover) as CacheCrossoverGroup[];
    const allLow = cloned(); for (const group of allLow) for (const sample of group.samples) (sample as { effort: string }).effort = "low";
    expect(() => assertEnforcementGates(syntheticManifest, runs, allLow, reviews)).toThrow("invalid");
    const duplicate = cloned(); duplicate[2] = structuredClone(duplicate[0]!);
    expect(() => assertEnforcementGates(syntheticManifest, runs, duplicate, reviews)).toThrow("duplicate");
    const wrongPhase = cloned(); (wrongPhase[1]!.samples[2] as { phase: string }).phase = "warm";
    expect(() => assertEnforcementGates(syntheticManifest, runs, wrongPhase, reviews)).toThrow("invalid");
  });

});
