import type { EvaluationRun } from "../runner/types.js";

export interface HumanReviewDecision { readonly runId: string; readonly taskId: string; readonly reviewer: string; readonly reviewedAt: string; readonly acceptance: "accept" | "reject" | "inconclusive"; readonly criticalFailure: boolean; readonly evidenceReference: string; readonly rationale: string }
export function isTraceableHumanDecision(value: HumanReviewDecision): boolean { return value.runId.length > 0 && value.taskId.length > 0 && value.reviewer.length > 0 && value.reviewedAt.length > 0 && value.evidenceReference.length > 0 && value.rationale.length > 0; }
/** Human evidence may supplement a run, but cannot refer to invented or mismatched run/task identities. */
export function validateHumanReviewDecisions(reviews: readonly HumanReviewDecision[], runs: readonly EvaluationRun[]): void {
  const byId = new Map(runs.map((run) => [run.id, run]));
  for (const review of reviews) { if (!isTraceableHumanDecision(review)) throw new Error(`human review for ${review.runId} is not traceable`); const run = byId.get(review.runId); if (!run) throw new Error(`human review references unknown run ${review.runId}`); if (run.taskId !== review.taskId) throw new Error(`human review task ${review.taskId} does not match run ${review.runId}`); }
}
