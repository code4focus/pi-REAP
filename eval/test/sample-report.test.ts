import { describe, expect, it } from "vitest";
import { syntheticManifest } from "../corpus/manifest.js";
import { validateHumanReviewDecisions } from "../graders/human.js";
import { renderMarkdownReport } from "../reports/markdown.js";
import { syntheticCacheCrossover, assessCrossover } from "../runner/cache-crossover.js";
import { effectiveCostMicros, syntheticTokenPricing } from "../runner/cost.js";
import { summarizeEvaluation } from "../runner/metrics.js";
import { runCandidateMatrix, runEvaluation } from "../runner/run.js";
import { PiSessionExecutor } from "../runner/pi-session.js";
import type { EvaluationExecutor, ExecutionRequest } from "../runner/types.js";

const executor: EvaluationExecutor = { execute: async (task, request) => ({ output: task.grader.expected, selectedEffort: request.requestedEffort ?? "medium", providerRequests: 1, toolRounds: 2, retries: 1, usage: { inputTokens: 20, uncachedInputTokens: 10, outputTokens: 2, reasoningTokens: 3, cacheReadTokens: 10, cacheWriteTokens: 1 }, latencyMs: 6 }) };
const productionOptions = { load: async () => ({ enabled: true, mode: "enforce" as const, ambiguousEffort: "high" as const, failureEffort: "xhigh" as const, telemetry: { enabled: false, includePromptText: false, directory: "synthetic" }, ui: { showStatus: false, notifyOnEscalation: false } }) };

describe("evaluation harness", () => {
  it("enforces fixed efforts, repeats regression comparisons, and calculates cost", async () => {
    const seen: ExecutionRequest[] = [];
    const recordingExecutor: EvaluationExecutor = { execute: async (task, request) => { seen.push(request); return executor.execute(task, request); } };
    const runs = await runEvaluation(syntheticManifest, recordingExecutor, { corpusMode: "regression", repetitions: 2 });
    expect(runs).toHaveLength(5 * 3 * 2);
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
    expect(metrics.byMode["fixed-xhigh"]!.toolRounds).toBe(10);
    const [a, b] = syntheticCacheCrossover;
    expect(assessCrossover(a!).crossoverRead).toBe(true);
    expect(assessCrossover(b!).crossoverWrite).toBe(true);
    expect(assessCrossover(b!).generationSavingsExceedAddedWrite).toBe(false);
    const review = { runId: runs[0]!.id, taskId: runs[0]!.taskId, reviewer: "synthetic-reviewer", reviewedAt: "2026-01-01T00:00:00Z", acceptance: "accept" as const, criticalFailure: false, evidenceReference: "synthetic://sample", rationale: "synthetic sample" };
    validateHumanReviewDecisions([review], runs);
    expect(() => validateHumanReviewDecisions([{ ...review, taskId: "fabricated" }], runs)).toThrow("does not match");
    expect(() => validateHumanReviewDecisions([{ ...review, runId: "fabricated" }], runs)).toThrow("unknown run");
    const report = renderMarkdownReport(syntheticManifest, runs, metrics, syntheticCacheCrossover, [review]);
    for (const required of ["fixed-xhigh", "fixed-high", "policy", "tool rounds", "cache read", "cache write", "provider requests", "retries", "effective cost", "Task-class strata", "Outcome oracle", "Traceable human review", "reduced reasoning/output cost", "synthetic sample"]) expect(report).toContain(required);
    expect(report).toContain("synthetic fixtures only");
    expect(report).not.toContain("release benefit");
  });

  it("drives controlled provider-adapter baselines and production-extension policy through one session", async () => {
    const live = await PiSessionExecutor.create(productionOptions);
    const runs = await runEvaluation(syntheticManifest, live, { corpusMode: "regression", repetitions: 1 });
    expect(runs).toHaveLength(15);
    expect(runs.filter((run) => run.mode === "fixed-xhigh").every((run) => run.result.selectedEffort === "xhigh")).toBe(true);
    expect(runs.filter((run) => run.mode === "fixed-high").every((run) => run.result.selectedEffort === "high")).toBe(true);
    const mismatchedLabel = { ...syntheticManifest.tasks[0]!, taskClass: "high_risk" as const, description: "What is JSON?" };
    expect((await live.execute(mismatchedLabel, { mode: "policy" })).selectedEffort).toBe("low");
  });

  it("records fixed and candidate efforts from their controlled adapter patches, not a session floor", async () => {
    const live = await PiSessionExecutor.create(productionOptions);
    const highRiskLabel = { ...syntheticManifest.tasks[0]!, taskClass: "high_risk" as const, description: "implement this feature" };
    expect((await live.execute(highRiskLabel, { mode: "fixed-high", requestedEffort: "high" })).selectedEffort).toBe("high");
    expect((await live.execute(highRiskLabel, { mode: "candidate", requestedEffort: "low" })).selectedEffort).toBe("low");
    expect(live.controlledAdapterCalls).toBe(2);
    expect(live.policyProviderHookCalls).toBe(0);
    const candidateRuns = await runCandidateMatrix(syntheticManifest, live, { corpusMode: "smoke" });
    expect(candidateRuns).toHaveLength(96);
    expect(live.controlledAdapterCalls).toBe(98);
  });

  it("rejects a controlled arm when the provider adapter maps a requested effort differently", async () => {
    const mapped = await PiSessionExecutor.create(productionOptions, { api: "openai-responses", reasoning: true, thinkingLevelMap: { low: "high" } });
    await expect(mapped.execute(syntheticManifest.tasks[0]!, { mode: "candidate", requestedEffort: "low" })).rejects.toThrow("control adapter applied high; expected low");
  });

  it("covers production epoch transitions and clears the local max override on session replacement", async () => {
    const live = await PiSessionExecutor.create(productionOptions);
    live.runLifecycle("implement this feature"); live.failTool(); live.failTool(); live.settle();
    expect(live.runLifecycle("explain this file")).toBe("medium"); live.settle();
    live.runLifecycle("implement this feature"); live.failTool(); live.failTool(); live.settle();
    expect(live.runLifecycle("implement a separate feature")).toBe("high"); live.settle();
    live.runLifecycle("What is JSON?"); live.settle("error");
    expect(live.runLifecycle("continue")).toBe("xhigh"); live.settle();
    for (const reason of ["new", "resume", "fork", "reload"] as const) {
      await live.setLocalEffort("max");
      await live.switchSession(reason);
      const next = live.runLifecycle("What is JSON?");
      expect(["low", "medium", "high", "xhigh"]).toContain(next);
      live.settle();
    }
  });
});
