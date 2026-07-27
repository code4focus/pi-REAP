import type { EvaluationRun } from "../runner/types.js";
import { canonicalProfileDigest } from "../../src/domain/canonical-json.js";

export interface HumanReviewDecision {
  readonly runId: string;
  readonly taskId: string;
  readonly reviewer: string;
  readonly reviewedAt: string;
  readonly acceptance: "accept" | "reject" | "inconclusive";
  readonly criticalFailure: boolean;
  readonly evidenceReference: string;
  readonly rationale: string;
  readonly profileDigest: string;
  readonly reportDigest: string;
  readonly sourceFingerprint: string;
  readonly extensionBuildFingerprint: string;
}
/** Synthetic contract evidence is intentionally distinct from a human disposition. */
export interface SyntheticUnderRouteContract { readonly kind: "synthetic_contract"; readonly runId: string; readonly taskId: string; readonly fixtureHash: string }
export type UnderRouteDisposition = HumanReviewDecision | SyntheticUnderRouteContract;
export function isTraceableHumanDecision(value: HumanReviewDecision): boolean {
  return value.runId.length > 0 && value.taskId.length > 0 && value.reviewer.length > 0
    && Number.isFinite(Date.parse(value.reviewedAt)) && value.evidenceReference.length > 0 && value.rationale.length > 0
    && [value.profileDigest, value.reportDigest, value.sourceFingerprint, value.extensionBuildFingerprint].every((item) => /^[a-f0-9]{64}$/u.test(item));
}
/** Human evidence may supplement a run, but cannot refer to invented or mismatched run/task identities. */
export function validateHumanReviewDecisions(reviews: readonly HumanReviewDecision[], runs: readonly EvaluationRun[]): void {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const reviewed = new Set<string>();
  for (const review of reviews) {
    if (!isTraceableHumanDecision(review)) throw new Error(`human review for ${review.runId} is not traceable`);
    const key = `${review.runId}\u0000${review.reviewer}\u0000${review.reviewedAt}\u0000${review.evidenceReference}`;
    if (reviewed.has(key)) throw new Error(`duplicate human review evidence for ${review.runId}`);
    reviewed.add(key);
    const run = byId.get(review.runId);
    if (!run) throw new Error(`human review references unknown run ${review.runId}`);
    if (run.taskId !== review.taskId) throw new Error(`human review task ${review.taskId} does not match run ${review.runId}`);
    if (run.result.observed.kind !== "observed") throw new Error(`human review run ${review.runId} has no exact profile observation`);
    const profile = canonicalProfileDigest(run.result.observed.profile);
    if (!profile.ok || profile.digest !== review.profileDigest) throw new Error(`human review profile does not match run ${review.runId}`);
  }
}
