import { describe, expect, it } from "vitest";
import { syntheticManifest } from "../corpus/manifest.js";
import { syntheticCacheCrossover, type CacheCrossoverGroup } from "../runner/cache-crossover.js";
import { assertEnforcementGates, assessEnforcementGates } from "../runner/gates.js";
import { runEvaluation } from "../runner/run.js";
import { PiSessionExecutor } from "../runner/pi-session.js";
import type { CorpusTask } from "../corpus/types.js";

const executor = () => PiSessionExecutor.create({ load: async () => ({ enabled: true, mode: "shadow", ambiguousEffort: "high", failureEffort: "xhigh", telemetry: { enabled: false, includePromptText: false, directory: "synthetic" }, ui: { showStatus: true, notifyOnEscalation: false } }) });

describe("PR 6 mandatory enforcement-gate machinery (synthetic evidence)", () => {
  it("requires both shadow and enforce comparisons, cache measurements, and synthetic contract dispositions without calling them human reviews", async () => {
    const runs = await runEvaluation(syntheticManifest, await executor(), { corpusMode: "regression", repetitions: 1 });
    const underRoute = runs.find((run) => run.mode === "policy-enforce" && run.taskId === "regression-under-routing-review")!;
    const reviews = [{ kind: "synthetic_contract" as const, runId: underRoute.id, taskId: underRoute.taskId, fixtureHash: "a".repeat(64) }];
    const evidence = assessEnforcementGates(syntheticManifest, runs, syntheticCacheCrossover, reviews);
    expect(evidence).toStrictEqual({ highRiskProtected: true, codingHasNoCriticalFailure: true, regressionWithinAllowance: true, requestCountsNotAmplified: true, cacheBehaviorNotAmplified: true, cacheCrossoverComplete: true, everyUnderRouteReviewed: true });
    expect(() => assertEnforcementGates(syntheticManifest, runs, syntheticCacheCrossover, reviews)).not.toThrow();
  });

  it("rejects missing review evidence for a fixed under-routing case", async () => {
    const runs = await runEvaluation(syntheticManifest, await executor(), { corpusMode: "regression", repetitions: 1 });
    expect(() => assertEnforcementGates(syntheticManifest, runs, syntheticCacheCrossover, [])).toThrow("everyUnderRouteReviewed");
  });

  it("fails closed for fabricated reviews, incomplete high-risk rows, and unmatched baseline subsets", async () => {
    const runs = await runEvaluation(syntheticManifest, await executor(), { corpusMode: "regression", repetitions: 1 });
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
    const runs = await runEvaluation(syntheticManifest, await executor(), { corpusMode: "regression", repetitions: 1 });
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

  it("derives policy effort from the production lifecycle prompt, not its corpus label", async () => {
    const task: CorpusTask = { ...syntheticManifest.tasks.find((entry) => entry.id === "regression-high-risk")!, description: "What is JSON?" };
    const result = await (await executor()).execute(task, { mode: "policy-enforce" });
    expect(result.selectedEffort).toBe("low");
  });

});
