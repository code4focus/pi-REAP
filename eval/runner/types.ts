import type { AutomaticEffort } from "../../src/domain/effort.js";
import type { TaskClass } from "../../src/domain/task-epoch.js";
import type { CorpusTask } from "../corpus/types.js";
import type { Grade } from "../graders/deterministic.js";

/**
 * Shadow and enforce are deliberately separate observations: only enforce is
 * permitted to alter a provider request.  Keeping them distinct prevents a
 * shadow recommendation from being presented as an applied effort.
 */
export type EvaluationMode = "fixed-xhigh" | "fixed-high" | "policy-shadow" | "policy-enforce" | "candidate";
export interface UsageMetrics { inputTokens: number; uncachedInputTokens: number; outputTokens: number; reasoningTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
export interface ExecutionRequest { readonly mode: EvaluationMode; readonly requestedEffort?: AutomaticEffort }
/** An executor reports observations; it never supplies the authoritative cost. */
export interface ExecutionResult {
  readonly output: string;
  readonly selectedEffort: AutomaticEffort;
  readonly providerRequests: number;
  readonly toolRounds: number;
  readonly retries: number;
  readonly usage: UsageMetrics;
  readonly latencyMs: number;
}
export interface EvaluationRun {
  readonly id: string;
  readonly taskId: string;
  readonly taskClass: TaskClass;
  readonly mode: EvaluationMode;
  readonly repetition: number;
  readonly result: ExecutionResult;
  readonly effectiveCostMicros: number;
  readonly grade: Grade;
}
export interface EvaluationExecutor { execute(task: CorpusTask, request: ExecutionRequest): Promise<ExecutionResult> }
