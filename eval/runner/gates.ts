import { canonicalProfileDigest } from "../../src/domain/canonical-json.js";
import { createProfileBinding, sameProfileMatch, type ProfileBinding } from "../../src/domain/profile.js";
import type { ProfileQualificationEvidence } from "../../src/qualification/enforcement.js";
import type { CorpusManifest, CorpusTask } from "../corpus/types.js";
import { validateHumanReviewDecisions, type HumanReviewDecision, type UnderRouteDisposition } from "../graders/human.js";
import { deriveCacheQualification, validateCacheCrossover, type CacheCrossoverGroup, type DerivedCacheQualification } from "./cache-crossover.js";
import type { EvaluationRun } from "./types.js";

export interface EnforcementGateEvidence {
  readonly exactProfileBindings: boolean;
  readonly qualityAllowancePassed: boolean;
  readonly requestCountsNotAmplified: boolean;
  readonly cacheCrossoverComplete: boolean;
  readonly everyUnderRouteReviewed: boolean;
}
export interface EnforcementEvidenceBinding {
  readonly reportDigest: string;
  readonly sourceFingerprint: string;
  readonly extensionBuildFingerprint: string;
  readonly cache: ProfileQualificationEvidence["cache"];
}
interface PolicyPair {
  readonly task: CorpusTask;
  readonly baseline: EvaluationRun;
  readonly policy: EvaluationRun;
  readonly binding: ProfileBinding;
}

/**
 * Recomputes every gate from an exact manifest matrix and canonical cache
 * groups. Caller-provided verdicts, counts, and report hashes are comparisons,
 * never authority.
 */
export function assessEnforcementGates(
  manifest: CorpusManifest,
  runs: readonly EvaluationRun[],
  cacheGroups: readonly CacheCrossoverGroup[],
  reviews: readonly UnderRouteDisposition[],
  evidence?: EnforcementEvidenceBinding,
): EnforcementGateEvidence {
  validateCacheCrossover(cacheGroups);
  const matrix = exactMatrix(manifest, runs);
  const human = reviews.filter((review): review is HumanReviewDecision => !("kind" in review));
  validateHumanReviewDecisions(human, runs);
  const degraded = matrix.pairs.filter(({ baseline, policy }) => baseline.grade.accepted && !policy.grade.accepted);
  const reviewByRun = new Map(human.map((review) => [review.runId, review]));
  const everyUnderRouteReviewed = degraded.every(({ policy }) => exactHumanDisposition(reviewByRun.get(policy.id), policy, matrix.reportDigest, evidence))
    && human.length === degraded.length
    && reviews.length === human.length;
  const exactProfileBindings = matrix.pairs.every(exactPairBinding);
  const requestCountsNotAmplified = matrix.pairs.every(({ baseline, policy }) =>
    policy.result.providerRequests <= baseline.result.providerRequests
    && (policy.result.retries === undefined || policy.result.retries === 0));
  const qualityAllowancePassed = degraded.length <= 1
    && degraded.every(({ policy }) => !policy.grade.criticalFailure && exactHumanDisposition(reviewByRun.get(policy.id), policy, matrix.reportDigest, evidence));
  const derivedCache = deriveCacheQualification(cacheGroups);
  const cacheCrossoverComplete = exactCachePass(derivedCache, matrix.pairs, evidence, matrix.reportDigest);
  return { exactProfileBindings, qualityAllowancePassed, requestCountsNotAmplified, cacheCrossoverComplete, everyUnderRouteReviewed };
}

export function assertEnforcementGates(
  manifest: CorpusManifest,
  runs: readonly EvaluationRun[],
  cacheGroups: readonly CacheCrossoverGroup[],
  reviews: readonly UnderRouteDisposition[],
  evidence?: EnforcementEvidenceBinding,
): EnforcementGateEvidence {
  const result = assessEnforcementGates(manifest, runs, cacheGroups, reviews, evidence);
  const failed = Object.entries(result).filter(([, value]) => !value).map(([key]) => key);
  if (failed.length) throw new Error(`enforcement gates failed: ${failed.join(", ")}`);
  return result;
}

function exactMatrix(manifest: CorpusManifest, runs: readonly EvaluationRun[]): { readonly pairs: readonly PolicyPair[]; readonly reportDigest: string } {
  const tasks = manifest.tasks.filter((task) => task.mode === "regression");
  if (tasks.some((task) => (task.profileState ?? "resolved") !== "resolved")) throw new Error("regression manifest contains an unresolved profile");
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new Error("regression manifest contains duplicate task identities");
  const requirement = manifest.stages.regression;
  if (tasks.length < requirement.minimumTasks || !Number.isSafeInteger(requirement.repetitions) || requirement.repetitions < 1) throw new Error("regression manifest requirement is incomplete");
  const expected = new Map<string, { readonly task: CorpusTask; readonly mode: "baseline" | "policy"; readonly repetition: number }>();
  for (const task of tasks) {
    for (let repetition = 1; repetition <= requirement.repetitions; repetition += 1) {
      for (const mode of ["baseline", "policy"] as const) expected.set(matrixKey(task.id, mode, repetition), { task, mode, repetition });
    }
  }
  if (runs.length !== expected.size) throw new Error("regression matrix has missing or extra rows");
  const actual = new Map<string, EvaluationRun>();
  for (const run of runs) {
    if (run.mode !== "baseline" && run.mode !== "policy") throw new Error(`extra regression mode ${run.mode}`);
    const key = matrixKey(run.taskId, run.mode, run.repetition);
    const expectedRow = expected.get(key);
    if (!expectedRow) throw new Error(`unexpected regression row ${key}`);
    if (actual.has(key)) throw new Error(`duplicate regression row ${key}`);
    if (run.id !== `${run.taskId}:${run.mode}:baseline:${run.repetition}`) throw new Error(`incorrect regression run identity ${run.id}`);
    actual.set(key, run);
  }
  if ([...expected.keys()].some((key) => !actual.has(key))) throw new Error("regression matrix has missing rows");
  const pairs: PolicyPair[] = [];
  for (const task of tasks) {
    const binding = createProfileBinding(task.profile.capability, task.profile.admission);
    if (!binding.ok) throw new Error(`mandatory regression task ${task.id} has an invalid profile`);
    for (let repetition = 1; repetition <= requirement.repetitions; repetition += 1) {
      pairs.push({
        task,
        binding: binding.binding,
        baseline: actual.get(matrixKey(task.id, "baseline", repetition))!,
        policy: actual.get(matrixKey(task.id, "policy", repetition))!,
      });
    }
  }
  const report = canonicalProfileDigest(runs);
  if (!report.ok) throw new Error("regression report is not canonical");
  return { pairs, reportDigest: report.digest };
}

function exactPairBinding(pair: PolicyPair): boolean {
  const { task, binding, baseline, policy } = pair;
  if (!sameRunProfile(baseline, task, binding) || !sameRunProfile(policy, task, binding)) return false;
  if (baseline.result.observed.kind !== "observed" || policy.result.observed.kind !== "observed") return false;
  const baselineRequest = baseline.result.observed.request;
  const policyRequest = policy.result.observed.request;
  const expectedProviderValue = policy.result.observed.routing.effective?.providerValue;
  return baselineRequest.patchStatus === "shadow"
    && baselineRequest.locallyAppliedProviderValue === undefined
    && policyRequest.patchStatus === "applied"
    && typeof expectedProviderValue === "string"
    && policyRequest.locallyAppliedProviderValue === expectedProviderValue;
}

function sameRunProfile(run: EvaluationRun, task: CorpusTask, binding: ProfileBinding): boolean {
  if (run.taskId !== task.id || run.result.observed.kind !== "observed") return false;
  const profile = run.result.observed.profile;
  return profile.capability.id === binding.capability.profileId
    && profile.capability.revision === binding.capability.profileRevision
    && profile.capability.digest === binding.capability.profileDigest
    && profile.admission.id === binding.admission.profileId
    && profile.admission.revision === binding.admission.profileRevision
    && profile.admission.digest === binding.admission.profileDigest
    && canonicalEqual(profile.capability.source, task.profile.capability.source)
    && canonicalEqual(profile.admission.source, task.profile.admission.source)
    && profile.model.provider === binding.match.provider
    && profile.model.api === binding.match.api
    && profile.model.model === binding.match.model
    && profile.model.catalogRevision === binding.match.modelCatalogRevision
    && profile.model.catalogDigest === binding.match.modelCatalogDigest
    && profile.model.piVersion === binding.match.piVersion
    && profile.model.adapterRevision === binding.match.providerAdapterRevision
    && profile.model.adapterDigest === binding.match.providerAdapterDigest
    && run.result.observed.request.provider === binding.match.provider
    && run.result.observed.request.api === binding.match.api
    && run.result.observed.request.model === binding.match.model;
}

function exactCachePass(derived: DerivedCacheQualification, pairs: readonly PolicyPair[], evidence: EnforcementEvidenceBinding | undefined, reportDigest: string): boolean {
  if (!evidence || evidence.reportDigest !== reportDigest || !hash(evidence.sourceFingerprint) || !hash(evidence.extensionBuildFingerprint)) return false;
  const claim = evidence.cache;
  if (derived.rawFieldObservability !== "observed" || derived.verdict !== "PASS" || !derived.binding
    || derived.positiveControlCachedTokens === undefined || derived.crossoverCachedTokens === undefined
    || derived.positiveControlCachedTokens <= 0 || derived.crossoverCachedTokens <= 0) return false;
  if (claim.groupsDigest !== derived.groupsDigest
    || claim.profileBindingDigest !== derived.profileBindingDigest
    || claim.environmentDigest !== derived.environmentDigest
    || claim.protocolDigest !== derived.protocolDigest
    || claim.authorizationDigest !== derived.authorizationDigest
    || claim.rawFieldObservability !== derived.rawFieldObservability
    || claim.positiveControlCachedTokens !== derived.positiveControlCachedTokens
    || claim.crossoverCachedTokens !== derived.crossoverCachedTokens
    || claim.verdict !== derived.verdict) return false;
  return pairs.every(({ binding }) =>
    binding.capability.profileId === derived.binding!.capability.profileId
    && binding.capability.profileRevision === derived.binding!.capability.profileRevision
    && binding.capability.profileDigest === derived.binding!.capability.profileDigest
    && binding.admission.profileId === derived.binding!.admission.profileId
    && binding.admission.profileRevision === derived.binding!.admission.profileRevision
    && binding.admission.profileDigest === derived.binding!.admission.profileDigest
    && sameProfileMatch(binding.match, derived.binding!.match));
}

function exactHumanDisposition(review: HumanReviewDecision | undefined, run: EvaluationRun, reportDigest: string, evidence: EnforcementEvidenceBinding | undefined): boolean {
  return review !== undefined
    && evidence !== undefined
    && review.runId === run.id
    && review.taskId === run.taskId
    && review.acceptance === "reject"
    && review.criticalFailure === false
    && review.reportDigest === reportDigest
    && review.sourceFingerprint === evidence.sourceFingerprint
    && review.extensionBuildFingerprint === evidence.extensionBuildFingerprint;
}
function canonicalEqual(left: unknown, right: unknown): boolean {
  const a = canonicalProfileDigest(left); const b = canonicalProfileDigest(right);
  return a.ok && b.ok && a.digest === b.digest;
}
function matrixKey(taskId: string, mode: "baseline" | "policy", repetition: number): string { return `${taskId}\u0000${mode}\u0000${repetition}`; }
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
