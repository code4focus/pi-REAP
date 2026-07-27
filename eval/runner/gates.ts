import type { CorpusManifest, CorpusTask } from "../corpus/types.js";
import { validateHumanReviewDecisions, type HumanReviewDecision, type UnderRouteDisposition } from "../graders/human.js";
import { validateCacheCrossover, type CacheCrossoverGroup } from "./cache-crossover.js";
import type { EvaluationMode, EvaluationRun } from "./types.js";

const rank = { low: 0, medium: 1, high: 2, xhigh: 3 } as const;
const regressionModes = ["fixed-xhigh", "fixed-high", "policy-shadow", "policy-enforce"] as const satisfies readonly EvaluationMode[];

export interface EnforcementGateEvidence {
  readonly highRiskProtected: boolean;
  readonly codingHasNoCriticalFailure: boolean;
  readonly regressionWithinAllowance: boolean;
  readonly requestCountsNotAmplified: boolean;
  readonly cacheBehaviorNotAmplified: boolean;
  readonly cacheCrossoverComplete: boolean;
  readonly everyUnderRouteReviewed: boolean;
}

/**
 * Validates a complete, matched regression matrix before calculating gates.
 * It deliberately rejects subsets: a passing label cannot replace evidence.
 */
export function assessEnforcementGates(manifest: CorpusManifest, runs: readonly EvaluationRun[], cacheGroups: readonly CacheCrossoverGroup[], reviews: readonly UnderRouteDisposition[]): EnforcementGateEvidence {
  const regressionTasks = manifest.tasks.filter((task) => task.mode === "regression");
  const byTask = new Map(regressionTasks.map((task) => [task.id, task]));
  if (regressionTasks.length === 0) throw new Error("regression manifest has no tasks");
  const repetitions = validateCompleteMatrix(regressionTasks, runs, byTask);
  const humanReviews = reviews.filter((review): review is HumanReviewDecision => !("kind" in review)); validateHumanReviewDecisions(humanReviews, runs);
  validateCacheCrossover(cacheGroups);

  const byKey = new Map(runs.map((run) => [key(run.taskId, run.mode, run.repetition), run]));
  const enforce = runs.filter((run) => run.mode === "policy-enforce");
  const highRisk = enforce.filter((run) => run.taskClass === "high_risk");
  const coding = enforce.filter((run) => run.taskClass === "implementation" || run.taskClass === "debugging");
  if (highRisk.length === 0 || coding.length === 0) throw new Error("regression matrix lacks required high-risk or coding enforce coverage");

  const matched = enforce.map((run) => ({ enforce: run, baseline: byKey.get(key(run.taskId, "fixed-xhigh", run.repetition))! }));
  const highRiskProtected = highRisk.every((run) => run.result.selectedEffort === "xhigh");
  const codingHasNoCriticalFailure = coding.every((run) => !run.grade.criticalFailure);
  const requestCountsNotAmplified = matched.every(({ enforce: policy, baseline }) => policy.result.providerRequests <= baseline.result.providerRequests);
  const cacheBehaviorNotAmplified = matched.every(({ enforce: policy, baseline }) => policy.result.usage.cacheWriteTokens <= baseline.result.usage.cacheWriteTokens && policy.result.usage.cacheReadTokens >= baseline.result.usage.cacheReadTokens);

  const reviewByRun = new Map(reviews.map((review) => [review.runId, review]));
  const underRoutes = enforce.filter((run) => {
    const task = byTask.get(run.taskId)!;
    return rank[run.result.selectedEffort] < rank[lowestAccepted(task)];
  });
  const fixtureRuns = enforce.filter((run) => byTask.get(run.taskId)!.underRoutingFixture === true);
  if (fixtureRuns.some((run) => !underRoutes.includes(run))) throw new Error("every fixed under-routing fixture must reproduce an under-route");
  const everyUnderRouteReviewed = underRoutes.every((run) => dispositionMatches(reviewByRun.get(run.id), run, byTask.get(run.taskId)!)) && reviews.length === underRoutes.length;

  const degradations = matched.filter(({ enforce: policy, baseline }) => baseline.grade.accepted && !policy.grade.accepted);
  const regressionWithinAllowance = degradations.length <= 1 && degradations.every(({ enforce: policy, baseline }) => !policy.grade.criticalFailure && baseline.grade.accepted && dispositionMatches(reviewByRun.get(policy.id), policy, byTask.get(policy.taskId)!) && byTask.get(policy.taskId)!.underRoutingFixture === true);
  const cacheCrossoverComplete = repetitions > 0; // matrix validation above is the evidence, not a caller boolean.
  return { highRiskProtected, codingHasNoCriticalFailure, regressionWithinAllowance, requestCountsNotAmplified, cacheBehaviorNotAmplified, cacheCrossoverComplete, everyUnderRouteReviewed };
}

/** Recomputes evidence from raw artifacts; it never accepts caller-provided flags. */
export function assertEnforcementGates(manifest: CorpusManifest, runs: readonly EvaluationRun[], cacheGroups: readonly CacheCrossoverGroup[], reviews: readonly UnderRouteDisposition[]): EnforcementGateEvidence {
  const evidence = assessEnforcementGates(manifest, runs, cacheGroups, reviews);
  const failed = Object.entries(evidence).filter(([, passed]) => !passed).map(([gate]) => gate);
  if (failed.length > 0) throw new Error(`enforcement gates failed: ${failed.join(", ")}`);
  return evidence;
}

function validateCompleteMatrix(tasks: readonly CorpusTask[], runs: readonly EvaluationRun[], byTask: ReadonlyMap<string, CorpusTask>): number {
  if (runs.length === 0) throw new Error("regression evidence is empty");
  const repetitions = new Set(runs.map((run) => run.repetition));
  const maxRepetition = Math.max(...repetitions);
  if (!Number.isInteger(maxRepetition) || maxRepetition < 1 || repetitions.size !== maxRepetition || !Array.from({ length: maxRepetition }, (_, index) => repetitions.has(index + 1)).every(Boolean)) throw new Error("regression repetitions must be a complete sequence starting at one");
  const expected = new Set<string>();
  for (const task of tasks) for (const mode of regressionModes) for (let repetition = 1; repetition <= maxRepetition; repetition += 1) expected.add(key(task.id, mode, repetition));
  const actual = new Set<string>();
  for (const run of runs) {
    const task = byTask.get(run.taskId);
    if (!task || !isRegressionMode(run.mode) || run.taskClass !== task.taskClass || run.repetition < 1 || !Number.isInteger(run.repetition)) throw new Error(`unexpected regression run ${run.id}`);
    const runKey = key(run.taskId, run.mode, run.repetition);
    if (actual.has(runKey)) throw new Error(`duplicate regression matrix row ${runKey}`);
    actual.add(runKey);
    if (run.id !== `${run.taskId}:${run.mode}:policy:${run.repetition}`) throw new Error(`mismatched regression run identity ${run.id}`);
  }
  if (actual.size !== expected.size || [...expected].some((row) => !actual.has(row))) throw new Error("regression matrix has missing or extra rows");
  return maxRepetition;
}

function reviewedRejection(review: UnderRouteDisposition | undefined, run: EvaluationRun): boolean {
  if (!review || "kind" in review) return false;
  return review?.taskId === run.taskId && review.acceptance === "reject" && review.criticalFailure === false;
}
function dispositionMatches(review: UnderRouteDisposition | undefined, run: EvaluationRun, task: CorpusTask): boolean {
  if (task.provenance === "synthetic") return review !== undefined && "kind" in review && review.kind === "synthetic_contract" && review.runId === run.id && review.taskId === run.taskId && /^[a-f0-9]{64}$/.test(review.fixtureHash);
  return reviewedRejection(review, run);
}
function lowestAccepted(task: CorpusTask): keyof typeof rank {
  return task.acceptedEfforts.reduce((lowest, effort) => rank[effort] < rank[lowest] ? effort : lowest);
}
function isRegressionMode(mode: EvaluationMode): mode is (typeof regressionModes)[number] { return (regressionModes as readonly EvaluationMode[]).includes(mode); }
function key(taskId: string, mode: EvaluationMode, repetition: number): string { return `${taskId}\u0000${mode}\u0000${repetition}`; }
