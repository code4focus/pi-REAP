import { describe, expect, it } from "vitest";
import { canonicalProfileDigest } from "../../src/domain/canonical-json.js";
import type { ProfileQualificationEvidence } from "../../src/qualification/enforcement.js";
import { syntheticManifest } from "../corpus/manifest.js";
import type { CorpusManifest, CorpusTask } from "../corpus/types.js";
import type { HumanReviewDecision, SyntheticUnderRouteContract } from "../graders/human.js";
import { deriveCacheQualification, syntheticCacheCrossover, validateCacheCrossover, type CacheCrossoverGroup } from "../runner/cache-crossover.js";
import { assertEnforcementGates, assessEnforcementGates, type EnforcementEvidenceBinding } from "../runner/gates.js";
import { PiSessionExecutor } from "../runner/pi-session.js";
import { runEvaluation } from "../runner/run.js";
import type { EvaluationRun } from "../runner/types.js";

const hash = (letter: string): string => letter.repeat(64);
const executor = () => PiSessionExecutor.create({ load: async () => ({ enabled: true, mode: "shadow", telemetry: { enabled: false, includePromptText: false, directory: "synthetic" }, ui: { showStatus: false, notifyOnEscalation: false } }) });
const target = syntheticManifest.tasks.find((task) => task.id === "regression-multi")!;
const manifestFor = (tasks: readonly CorpusTask[], repetitions = 1): CorpusManifest => ({
  schemaVersion: 2,
  name: "synthetic-pr6-gate",
  sourceSafety: "synthetic fixtures only",
  stages: { smoke: { minimumTasks: 1, repetitions: 1 }, calibration: { minimumTasks: 1, repetitions: 1 }, regression: { minimumTasks: tasks.length, repetitions } },
  tasks,
});
const reportDigest = (runs: readonly EvaluationRun[]): string => {
  const result = canonicalProfileDigest(runs);
  if (!result.ok) throw new Error("synthetic matrix must be canonical");
  return result.digest;
};
const positiveCache = (): CacheCrossoverGroup[] => structuredClone(syntheticCacheCrossover).map((group) => ({
  ...group,
  samples: group.samples.map((sample, index) => {
    if (index === 1) return { ...sample, rawCacheRead: { status: "present" as const, value: sample.usage.cacheReadTokens! } };
    if (index === 2) {
      const cacheReadTokens = sample.usage.cacheReadTokens! > 0 ? sample.usage.cacheReadTokens! : 120;
      return {
        ...sample,
        usage: { ...sample.usage, inputTokens: cacheReadTokens, uncachedInputTokens: 0, cacheReadTokens },
        rawCacheRead: { status: "present" as const, value: cacheReadTokens },
      };
    }
    return sample;
  }) as unknown as CacheCrossoverGroup["samples"],
}));
const evidenceFor = (runs: readonly EvaluationRun[], cacheGroups: readonly CacheCrossoverGroup[]): EnforcementEvidenceBinding => {
  const derived = deriveCacheQualification(cacheGroups);
  if (!derived.profileBindingDigest || !derived.environmentDigest || !derived.protocolDigest || !derived.authorizationDigest
    || derived.positiveControlCachedTokens === undefined || derived.crossoverCachedTokens === undefined) throw new Error("synthetic raw cache evidence must be complete");
  const cache: ProfileQualificationEvidence["cache"] = {
    groupsDigest: derived.groupsDigest,
    profileBindingDigest: derived.profileBindingDigest,
    environmentDigest: derived.environmentDigest,
    protocolDigest: derived.protocolDigest,
    authorizationDigest: derived.authorizationDigest,
    rawFieldObservability: derived.rawFieldObservability,
    positiveControlCachedTokens: derived.positiveControlCachedTokens,
    crossoverCachedTokens: derived.crossoverCachedTokens,
    verdict: derived.verdict,
  };
  return { reportDigest: reportDigest(runs), sourceFingerprint: hash("a"), extensionBuildFingerprint: hash("b"), cache };
};
const positiveRuns = async (): Promise<EvaluationRun[]> => {
  const all = await runEvaluation(syntheticManifest, await executor(), { corpusMode: "regression", repetitions: 1 });
  return all.filter((run) => run.taskId === target.id && (run.mode === "baseline" || run.mode === "policy")).map((run) => {
    if (run.result.observed.kind !== "observed") throw new Error("synthetic gate run must be observed");
    if (run.mode === "baseline") return { ...run, grade: { ...run.grade, accepted: true, criticalFailure: false } };
    const providerValue = run.result.observed.routing.effective?.providerValue;
    if (!providerValue) throw new Error("synthetic policy run must resolve a provider value");
    return {
      ...run,
      result: { ...run.result, observed: { ...run.result.observed, request: { ...run.result.observed.request, patchStatus: "applied" as const, locallyAppliedProviderValue: providerValue } } },
      grade: { ...run.grade, accepted: true, criticalFailure: false },
    };
  });
};

describe("PR6 exact profile-relative enforcement gates", () => {
  it("accepts only a complete exact baseline+policy matrix and canonically bound raw cache PASS", async () => {
    const runs = await positiveRuns(); const cache = positiveCache(); const evidence = evidenceFor(runs, cache);
    expect(assertEnforcementGates(manifestFor([target]), runs, cache, [], evidence)).toStrictEqual({
      exactProfileBindings: true,
      qualityAllowancePassed: true,
      requestCountsNotAmplified: true,
      cacheCrossoverComplete: true,
      everyUnderRouteReviewed: true,
    });
    expect(deriveCacheQualification(cache)).toMatchObject({ verdict: "PASS", rawFieldObservability: "observed" });
  });

  it("rejects omitted critical coverage, duplicate/extra/wrong identities, repetitions, and cross-profile rows", async () => {
    const runs = await positiveRuns(); const cache = positiveCache(); const evidence = evidenceFor(runs, cache);
    const critical = { ...target, id: "regression-critical", taskClass: "high_risk", description: "synthetic critical fixture" };
    expect(() => assertEnforcementGates(manifestFor([target, critical]), runs, cache, [], evidence)).toThrow("missing or extra");
    expect(() => assertEnforcementGates(manifestFor([target, { ...critical, profileState: "unknown" }]), runs, cache, [], evidence)).toThrow("unresolved profile");
    expect(() => assertEnforcementGates(manifestFor([target, { ...critical, id: target.id }]), runs, cache, [], evidence)).toThrow("duplicate task");
    expect(() => assertEnforcementGates(manifestFor([target]), [...runs, runs[0]!], cache, [], evidence)).toThrow("missing or extra");
    expect(() => assertEnforcementGates(manifestFor([target]), [...runs, { ...runs[0]!, mode: "automatic" }], cache, [], evidence)).toThrow("missing or extra");
    expect(() => assertEnforcementGates(manifestFor([target]), runs.map((run, index) => index === 0 ? { ...run, id: "wrong" } : run), cache, [], evidence)).toThrow("incorrect");
    expect(() => assertEnforcementGates(manifestFor([target], 2), runs, cache, [], evidence)).toThrow("missing or extra");
    const otherProfile = syntheticManifest.tasks.find((task) => task.id === "regression-two")!;
    expect(() => assertEnforcementGates(manifestFor([{ ...target, profile: otherProfile.profile }]), runs, cache, [], evidence)).toThrow("exactProfileBindings");
  });

  it("recomputes cache groups and rejects claimed PASS mutation, unobservable, zero-control, and crossover regression", async () => {
    const runs = await positiveRuns(); const cache = positiveCache(); const evidence = evidenceFor(runs, cache);
    expect(assessEnforcementGates(manifestFor([target]), runs, cache, [], { ...evidence, cache: { ...evidence.cache, groupsDigest: hash("c") } }).cacheCrossoverComplete).toBe(false);
    const unavailable = structuredClone(cache); for (const group of unavailable) delete (group.samples[1] as { rawCacheRead?: unknown }).rawCacheRead;
    expect(deriveCacheQualification(unavailable)).toMatchObject({ verdict: "OBSERVABILITY_UNAVAILABLE", rawFieldObservability: "unavailable" });
    const zeroControl = structuredClone(cache);
    zeroControl[0]!.samples[1] = { ...zeroControl[0]!.samples[1], usage: { ...zeroControl[0]!.samples[1].usage, inputTokens: 0, uncachedInputTokens: 0, cacheReadTokens: 0 }, rawCacheRead: { status: "present", value: 0 } };
    expect(deriveCacheQualification(zeroControl)).toMatchObject({ verdict: "ENVIRONMENT_UNQUALIFIED" });
    const regression = structuredClone(cache);
    regression[0]!.samples[2] = { ...regression[0]!.samples[2], usage: { ...regression[0]!.samples[2].usage, inputTokens: 0, uncachedInputTokens: 0, cacheReadTokens: 0 }, rawCacheRead: { status: "present", value: 0 } };
    expect(deriveCacheQualification(regression)).toMatchObject({ verdict: "REGRESSION" });
    const empty = structuredClone(cache); empty[0]!.controls = {};
    expect(() => validateCacheCrossover(empty)).toThrow("empty, partial, or unknown");
    const allZero = structuredClone(cache);
    allZero[0]!.samples = allZero[0]!.samples.map((sample) => ({ ...sample, usage: { inputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, ...(sample.rawCacheRead ? { rawCacheRead: { status: "present" as const, value: 0 } } : {}) })) as unknown as CacheCrossoverGroup["samples"];
    expect(() => validateCacheCrossover(allZero)).toThrow("all-zero");
  });

  it("rejects synthetic-only disposition and accepts an exact run-bound human review", async () => {
    const accepted = await positiveRuns(); const cache = positiveCache();
    const runs = accepted.map((run) => run.mode === "policy" ? { ...run, grade: { ...run.grade, accepted: false, criticalFailure: false } } : run);
    const evidence = evidenceFor(runs, cache);
    const policy = runs.find((run) => run.mode === "policy")!;
    const synthetic: SyntheticUnderRouteContract = { kind: "synthetic_contract", runId: policy.id, taskId: policy.taskId, fixtureHash: hash("c") };
    expect(assessEnforcementGates(manifestFor([target]), runs, cache, [synthetic], evidence)).toMatchObject({ qualityAllowancePassed: false, everyUnderRouteReviewed: false });
    if (policy.result.observed.kind !== "observed") throw new Error("synthetic policy must be observed");
    const profile = canonicalProfileDigest(policy.result.observed.profile);
    if (!profile.ok) throw new Error("synthetic review profile must be canonical");
    const review: HumanReviewDecision = {
      runId: policy.id,
      taskId: policy.taskId,
      reviewer: "synthetic-human-reviewer",
      reviewedAt: "2026-07-27T12:00:00Z",
      acceptance: "reject",
      criticalFailure: false,
      evidenceReference: "synthetic://human-review/evidence",
      rationale: "Synthetic human-review fixture for exact gate plumbing.",
      profileDigest: profile.digest,
      reportDigest: evidence.reportDigest,
      sourceFingerprint: evidence.sourceFingerprint,
      extensionBuildFingerprint: evidence.extensionBuildFingerprint,
    };
    expect(assertEnforcementGates(manifestFor([target]), runs, cache, [review], evidence)).toMatchObject({ qualityAllowancePassed: true, everyUnderRouteReviewed: true });
    expect(() => assertEnforcementGates(manifestFor([target]), runs, cache, [{ ...review, reportDigest: hash("d") }], evidence)).toThrow("qualityAllowancePassed");
  });
});
