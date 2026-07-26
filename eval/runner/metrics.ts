import type { AutomaticEffort } from "../../src/domain/effort.js";
import type { CorpusManifest } from "../corpus/types.js";
import type { EvaluationRun } from "./types.js";

export interface ModeMetrics { runs: number; successes: number; criticalFailures: number; providerRequests: number; toolRounds: number; retries: number; inputTokens: number; uncachedInputTokens: number; outputTokens: number; reasoningTokens: number; cacheReadTokens: number; cacheWriteTokens: number; latencyMs: number; effectiveCostMicros: number }
export interface EvaluationMetrics { byMode: Record<string, ModeMetrics>; byTaskClass: Record<string, Record<string, ModeMetrics>>; oracleByTask: Record<string, AutomaticEffort | "unresolved">; underRoutingRate: number; qualityRegretVsXhigh: number; requestAmplificationVsXhigh: number; cacheWriteAmplificationVsXhigh: number; }
const empty = (): ModeMetrics => ({ runs: 0, successes: 0, criticalFailures: 0, providerRequests: 0, toolRounds: 0, retries: 0, inputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 0, effectiveCostMicros: 0 });
const add = (metrics: ModeMetrics, run: EvaluationRun): void => { const { result, grade } = run; metrics.runs += 1; metrics.successes += Number(grade.accepted); metrics.criticalFailures += Number(grade.criticalFailure); metrics.providerRequests += result.providerRequests; metrics.toolRounds += result.toolRounds; metrics.retries += result.retries; metrics.inputTokens += result.usage.inputTokens; metrics.uncachedInputTokens += result.usage.uncachedInputTokens; metrics.outputTokens += result.usage.outputTokens; metrics.reasoningTokens += result.usage.reasoningTokens; metrics.cacheReadTokens += result.usage.cacheReadTokens; metrics.cacheWriteTokens += result.usage.cacheWriteTokens; metrics.latencyMs += result.latencyMs; metrics.effectiveCostMicros += run.effectiveCostMicros; };
const rank: Record<AutomaticEffort, number> = { low: 0, medium: 1, high: 2, xhigh: 3 };

/** The oracle is the lowest observed effort that preserved deterministic acceptance. */
export function summarizeEvaluation(manifest: CorpusManifest, runs: readonly EvaluationRun[]): EvaluationMetrics {
  const byMode: Record<string, ModeMetrics> = {}; const byTaskClass: Record<string, Record<string, ModeMetrics>> = {};
  for (const run of runs) { const mode = byMode[run.mode] ??= empty(); add(mode, run); const strata = byTaskClass[run.taskClass] ??= {}; const classMode = strata[run.mode] ??= empty(); add(classMode, run); }
  const oracleByTask: Record<string, AutomaticEffort | "unresolved"> = {};
  for (const task of manifest.tasks) { const accepted = runs.filter((run) => run.taskId === task.id && run.grade.accepted).map((run) => run.result.selectedEffort).sort((a, b) => rank[a]! - rank[b]!); const lowest = accepted.at(0); oracleByTask[task.id] = lowest ?? "unresolved"; }
  const policy = byMode.policy ?? empty(); const xhigh = byMode["fixed-xhigh"] ?? empty();
  const policyRuns = runs.filter((run) => run.mode === "policy"); const under = policyRuns.filter((run) => { const oracle = oracleByTask[run.taskId] ?? "unresolved"; return oracle !== "unresolved" && rank[run.result.selectedEffort]! < rank[oracle]!; }).length;
  const xhighSuccess = xhigh.successes; const policySuccess = policy.successes;
  return { byMode, byTaskClass, oracleByTask, underRoutingRate: policyRuns.length === 0 ? 0 : under / policyRuns.length, qualityRegretVsXhigh: xhighSuccess === 0 ? 0 : (xhighSuccess - policySuccess) / xhighSuccess, requestAmplificationVsXhigh: policy.providerRequests - xhigh.providerRequests, cacheWriteAmplificationVsXhigh: policy.cacheWriteTokens - xhigh.cacheWriteTokens };
}
