import type { AutomaticEffort } from "../../src/domain/effort.js";
import type { CorpusTask } from "../corpus/types.js";

export interface Grade { readonly accepted: boolean; readonly criticalFailure: boolean; readonly confidence: "high"; readonly explanation: string }

/** Exact expected-output grader for controlled, deterministic corpus tasks. */
export function gradeDeterministically(task: CorpusTask, output: string, effort: AutomaticEffort): Grade {
  const accepted = output === task.grader.expected && task.acceptedEfforts.includes(effort);
  return { accepted, criticalFailure: !accepted && task.nonCriticalRejection !== true, confidence: "high", explanation: accepted ? "exact synthetic expectation and effort threshold matched" : "synthetic expectation or effort threshold did not match" };
}
