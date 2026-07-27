import { describe, expect, it } from "vitest";
import { syntheticManifest } from "../corpus/manifest.js";
import { validateHumanReviewDecisions } from "../graders/human.js";
import { renderMarkdownReport } from "../reports/markdown.js";
import { syntheticCacheCrossover, assessCrossover } from "../runner/cache-crossover.js";
import { effectiveCostMicros, syntheticTokenPricing } from "../runner/cost.js";
import { summarizeEvaluation } from "../runner/metrics.js";
import { runCandidateMatrix, runEvaluation } from "../runner/run.js";
import type { EvaluationExecutor, ExecutionRequest } from "../runner/types.js";

const executor: EvaluationExecutor = { execute: async (task, request) => ({ output: task.grader.expected, selectedEffort: request.requestedEffort ?? (task.taskClass === "high_risk" ? "xhigh" : task.taskClass === "simple_query" ? "low" : "medium"), providerRequests: 1, toolRounds: 2, retries: 1, usage: { inputTokens: 20, uncachedInputTokens: 10, outputTokens: 2, reasoningTokens: 3, cacheReadTokens: 10, cacheWriteTokens: 1 }, latencyMs: 6 }) };

describe("evaluation harness", () => {
  it("enforces fixed efforts, repeats regression comparisons, and calculates cost", async () => {
    const seen: ExecutionRequest[] = [];
    const recordingExecutor: EvaluationExecutor = { execute: async (task, request) => { seen.push(request); return executor.execute(task, request); } };
    const runs = await runEvaluation(syntheticManifest, recordingExecutor, { corpusMode: "regression", repetitions: 2 });
    expect(runs).toHaveLength(6 * 4 * 2);
    expect(seen.filter((request) => request.mode === "fixed-xhigh").every((request) => request.requestedEffort === "xhigh")).toBe(true);
    expect(seen.filter((request) => request.mode === "fixed-high").every((request) => request.requestedEffort === "high")).toBe(true);
    expect(runs.find((run) => run.mode === "fixed-xhigh")!.effectiveCostMicros).toBe(252);
    expect(effectiveCostMicros({ inputTokens: 99, uncachedInputTokens: 10, outputTokens: 2, reasoningTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5 }, syntheticTokenPricing)).toBe(288);
  });

  it("rejects an executor that violates a fixed baseline", async () => {
    const liar: EvaluationExecutor = { execute: async (task) => ({ ...(await executor.execute(task, { mode: "fixed-high", requestedEffort: "high" })), selectedEffort: "low" }) };
    await expect(runEvaluation(syntheticManifest, liar, { corpusMode: "regression", repetitions: 1 })).rejects.toThrow("fixed-xhigh executor returned low; expected xhigh");
  });

  it("validates smoke and calibration matrix contracts", async () => {
    const smoke = await runCandidateMatrix(syntheticManifest, executor, { corpusMode: "smoke" });
    const calibration = await runCandidateMatrix(syntheticManifest, executor, { corpusMode: "calibration" });
    expect(smoke).toHaveLength(12 * 4 * 2);
    expect(calibration).toHaveLength(108 * 3);
  });

  it("rejects a candidate executor that ignores the requested effort", async () => {
    const liar: EvaluationExecutor = { execute: async (task, request) => ({ ...(await executor.execute(task, request)), selectedEffort: "xhigh" }) };
    await expect(runCandidateMatrix(syntheticManifest, liar, { corpusMode: "smoke" })).rejects.toThrow("candidate executor returned xhigh; expected low");
  });

  it("reports class strata, meaningful lowest-effort oracle, tool rounds, cache measurements, and validated human evidence", async () => {
    const runs = await runEvaluation(syntheticManifest, executor, { corpusMode: "regression", repetitions: 1 });
    const metrics = summarizeEvaluation(syntheticManifest, runs);
    expect(metrics.oracleByTask["regression-implementation"]).toBe("high");
    expect(metrics.byMode["fixed-xhigh"]!.toolRounds).toBe(12);
    const [a, b] = syntheticCacheCrossover;
    expect(assessCrossover(a!).crossoverRead).toBe(true);
    expect(assessCrossover(b!).crossoverWrite).toBe(true);
    expect(assessCrossover(b!).generationSavingsExceedAddedWrite).toBe(false);
    const review = { runId: runs[0]!.id, taskId: runs[0]!.taskId, reviewer: "synthetic-reviewer", reviewedAt: "2026-01-01T00:00:00Z", acceptance: "accept" as const, criticalFailure: false, evidenceReference: "synthetic://sample", rationale: "synthetic sample" };
    validateHumanReviewDecisions([review], runs);
    expect(() => validateHumanReviewDecisions([{ ...review, taskId: "fabricated" }], runs)).toThrow("does not match");
    expect(() => validateHumanReviewDecisions([{ ...review, runId: "fabricated" }], runs)).toThrow("unknown run");
    const report = renderMarkdownReport(syntheticManifest, runs, metrics, syntheticCacheCrossover, [review]);
    for (const required of ["fixed-xhigh", "fixed-high", "policy-shadow", "policy-enforce", "tool rounds", "cache read", "cache write", "provider requests", "retries", "effective cost", "Task-class strata", "Outcome oracle", "Traceable human review", "reduced reasoning/output cost", "synthetic sample"]) expect(report).toContain(required);
    expect(report).toContain("synthetic fixtures only");
    expect(report).not.toContain("release benefit");
  });
});
