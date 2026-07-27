import type { CorpusTask } from "../corpus/types.js";
import type { EvaluationRun } from "../runner/types.js";
export interface Grade { readonly accepted: boolean; readonly criticalFailure: boolean; readonly confidence: "high"; readonly explanation: string }
/** The oracle declares profile-bound expected behavior; it never routes a request. */
export function gradeDeterministically(task: CorpusTask, run: Pick<EvaluationRun, "result">): Grade {
  const observed = run.result.observed;
  const accepted = observed.kind === "observed"
    && observed.output?.value === task.expectedOutput
    && (run.result.expected.baselineArm ? observed.request.patchStatus === "shadow" : observed.request.patchStatus === "applied");
  return { accepted, criticalFailure: !accepted, confidence: "high", explanation: accepted ? "synthetic oracle matched a separately observed provider lifecycle response" : "synthetic oracle did not match observed production evidence" };
}
