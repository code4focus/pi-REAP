import type { AutomaticEffort } from "../../src/domain/effort.js";
import type { CorpusManifest, CorpusMode, CorpusTask } from "../corpus/types.js";
import { gradeDeterministically } from "../graders/deterministic.js";
import { effectiveCostMicros, syntheticTokenPricing, type TokenPricing } from "./cost.js";
import type { EvaluationExecutor, EvaluationMode, EvaluationRun, ExecutionRequest } from "./types.js";

export interface RunnerOptions { readonly modes?: readonly Exclude<EvaluationMode, "candidate">[]; readonly repetitions: number; readonly corpusMode?: CorpusMode; readonly pricing?: TokenPricing }
export interface CandidateMatrixOptions { readonly corpusMode: "smoke" | "calibration"; readonly repetitions?: number; readonly pricing?: TokenPricing }
const requiredModes = ["fixed-xhigh", "fixed-high", "policy-shadow", "policy-enforce"] as const;
const fixedEffort: Record<"fixed-xhigh" | "fixed-high", AutomaticEffort> = { "fixed-xhigh": "xhigh", "fixed-high": "high" };

function requestFor(mode: EvaluationMode, effort?: AutomaticEffort): ExecutionRequest {
  return mode === "fixed-xhigh" || mode === "fixed-high" ? { mode, requestedEffort: fixedEffort[mode] } : effort ? { mode, requestedEffort: effort } : { mode };
}
async function executeRun(task: CorpusTask, executor: EvaluationExecutor, mode: EvaluationMode, repetition: number, pricing: TokenPricing, candidateEffort?: AutomaticEffort): Promise<EvaluationRun> {
  const request = requestFor(mode, candidateEffort);
  const result = await executor.execute(task, request);
  if ((mode === "fixed-xhigh" || mode === "fixed-high" || mode === "candidate") && result.selectedEffort !== request.requestedEffort) throw new Error(`${mode} executor returned ${result.selectedEffort}; expected ${request.requestedEffort}`);
  return { id: `${task.id}:${mode}:${candidateEffort ?? "policy"}:${repetition}`, taskId: task.id, taskClass: task.taskClass, mode, repetition, result, effectiveCostMicros: effectiveCostMicros(result.usage, pricing), grade: gradeDeterministically(task, result.output, result.selectedEffort) };
}

/** Runs every required fixed baseline plus shadow and enforce comparisons. */
export async function runEvaluation(manifest: CorpusManifest, executor: EvaluationExecutor, options: RunnerOptions): Promise<EvaluationRun[]> {
  const modes = options.modes ?? requiredModes;
  if (!requiredModes.every((mode) => modes.includes(mode))) throw new Error("evaluation must compare fixed-xhigh, fixed-high, and policy");
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1) throw new Error("repetitions must be at least one");
  const tasks = manifest.tasks.filter((task) => options.corpusMode === undefined || task.mode === options.corpusMode);
  const pricing = options.pricing ?? syntheticTokenPricing; const runs: EvaluationRun[] = [];
  for (const task of tasks) for (const mode of modes) for (let repetition = 1; repetition <= options.repetitions; repetition += 1) runs.push(await executeRun(task, executor, mode, repetition, pricing));
  return runs;
}

/** Executes the packet's smoke/calibration candidate-effort matrices without replacing regression baselines. */
export async function runCandidateMatrix(manifest: CorpusManifest, executor: EvaluationExecutor, options: CandidateMatrixOptions): Promise<EvaluationRun[]> {
  const requirements = manifest.stages[options.corpusMode];
  const repetitions = options.repetitions ?? requirements.repetitions;
  if (repetitions !== requirements.repetitions) throw new Error(`${options.corpusMode} requires ${requirements.repetitions} repetitions`);
  const tasks = manifest.tasks.filter((task) => task.mode === options.corpusMode);
  if (tasks.length < requirements.minimumTasks) throw new Error(`${options.corpusMode} requires at least ${requirements.minimumTasks} tasks`);
  if (requirements.requiredCandidateEfforts && !tasks.every((task) => requirements.requiredCandidateEfforts!.every((effort) => task.candidateEfforts.includes(effort)))) throw new Error(`${options.corpusMode} tasks must include every required candidate effort`);
  const pricing = options.pricing ?? syntheticTokenPricing; const runs: EvaluationRun[] = [];
  for (const task of tasks) for (const effort of task.candidateEfforts) for (let repetition = 1; repetition <= repetitions; repetition += 1) runs.push(await executeRun(task, executor, "candidate", repetition, pricing, effort));
  return runs;
}
