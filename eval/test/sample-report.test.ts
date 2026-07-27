import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalProfileDigest } from "../../src/domain/canonical-json.js";
import { syntheticManifest, profileFixtures } from "../corpus/manifest.js";
import { gradeDeterministically } from "../graders/deterministic.js";
import { validateHumanReviewDecisions, type HumanReviewDecision } from "../graders/human.js";
import { renderMarkdownReport } from "../reports/markdown.js";
import { syntheticCacheCrossover } from "../runner/cache-crossover.js";
import { summarizeEvaluation } from "../runner/metrics.js";
import { observedRequestKeyIdentity, observeTelemetry } from "../runner/observations.js";
import { PiSessionExecutor } from "../runner/pi-session.js";
import { comparisonArms, evidenceTriggers, metadataOnlyArms, runCandidateMatrix, runEvaluation, scenarioForEvidence } from "../runner/run.js";
import type { EvaluationExecutor } from "../runner/types.js";

const writeJsonl = (directory: string, name: string, rows: readonly Record<string, unknown>[]): void => writeFileSync(join(directory, name), rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""));
function parseRows(decisions: readonly Record<string, unknown>[], requests: readonly Record<string, unknown>[], epochs: readonly Record<string, unknown>[], hookPayload: unknown): ReturnType<typeof observeTelemetry> {
  const directory = mkdtempSync(join(process.cwd(), "eval", ".tmp-observation-"));
  try { writeJsonl(directory, "decisions.jsonl", decisions); writeJsonl(directory, "requests.jsonl", requests); writeJsonl(directory, "epochs.jsonl", epochs); return observeTelemetry(directory, hookPayload, "synthetic-output"); } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("profile-aware evaluation harness", () => {
  it("deduplicates executable arms by profile/rung while retaining selector aliases", () => {
    const alias = comparisonArms({ ...syntheticManifest.tasks[0]!, profile: profileFixtures.alias });
    const executable = alias.filter((arm) => arm.mode === "anchor" || arm.mode === "automatic");
    expect(executable).toHaveLength(1);
    expect(executable[0]!.selectorAliases?.length).toBeGreaterThan(1);
    expect(comparisonArms({ ...syntheticManifest.tasks[0]!, profile: profileFixtures.explicitOnly }).some((arm) => arm.mode === "manual-diagnostic")).toBe(true);
    expect(comparisonArms(syntheticManifest.tasks.find((task) => task.profileState === "unknown")!)).toMatchObject([{ mode: "baseline" }]);
    const metadata = metadataOnlyArms(syntheticManifest.tasks.find((task) => task.id === "cal-multi")!);
    expect(metadata).toEqual([{ mode: "metadata-only", alias: { source: "initial", admissionCase: "debugging", selector: { kind: "anchor", name: "deliberate" }, reachable: false }, requestedRungId: "max-auto", reason: "no-production-lifecycle-driver" }]);
    const maxArm = comparisonArms(syntheticManifest.tasks.find((task) => task.id === "cal-multi")!).find((arm) => arm.requestedRungId === "max-auto");
    expect(maxArm?.armAliases?.filter((alias) => alias.source === "evidence").map((alias) => alias.source === "evidence" ? alias.trigger : undefined)).toEqual(evidenceTriggers);
  });

  it("separates oracle expectation from actual typed production observations", async () => {
    const executor = await PiSessionExecutor.create({});
    const task = syntheticManifest.tasks.find((value) => value.id === "regression-two")!;
    const result = await executor.execute(task, { mode: "policy" });
    expect(result.expected).toEqual({ baselineArm: false, expectedOutput: task.expectedOutput, provenance: "synthetic-oracle" });
    expect(result.observed.kind).toBe("observed");
    if (result.observed.kind !== "observed") return;
    expect(result.observed.output).toEqual({ value: `synthetic-${task.id}-answer`, provenance: "synthetic-provider-lifecycle" });
    expect(result.observed.profile.capability.id).toBe(task.profile.capability.profileId);
    expect(result.observed.profile.admission.id).toBe(task.profile.admission.profileId);
    expect(result.observed.routing.effective).toEqual({ rungId: "economy", ordinal: 0, providerValue: "minimal" });
    expect(result.observed.request.patchStatus).toBe("shadow");
    expect(result.observed.request.locallyAppliedProviderValue).toBeUndefined();
    expect(result.observed.request.key).toMatchObject({ requestIndex: 1 });
    expect(gradeDeterministically(task, { result })).toMatchObject({ accepted: false, criticalFailure: true });
  });

  it("keeps fail-closed evidence absent instead of fabricating a baseline rung", async () => {
    const executor = await PiSessionExecutor.create({});
    const failed = syntheticManifest.tasks.filter((task) => task.mode === "regression" && task.profileState !== "resolved");
    expect(failed.length).toBeGreaterThanOrEqual(13);
    for (const task of failed) {
      const result = await executor.execute(task, { mode: "policy" });
      expect(result.observed).toEqual({ kind: "unavailable", reason: "no-telemetry" });
      expect(JSON.stringify(result.observed)).not.toContain("baseline");
    }
  });

  it("compares distinct immutable factory snapshots and a true five-rung profile", async () => {
    const executor = await PiSessionExecutor.create({});
    const original = syntheticManifest.tasks.find((task) => task.id === "regression-two")!;
    const revised = syntheticManifest.tasks.find((task) => task.id === "regression-revised")!;
    const [first, second] = await Promise.all([executor.execute(original, { mode: "policy" }), executor.execute(revised, { mode: "policy" })]);
    expect(first.observed.kind).toBe("observed"); expect(second.observed.kind).toBe("observed");
    if (first.observed.kind === "observed" && second.observed.kind === "observed") expect(first.observed.profile.capability.digest).not.toBe(second.observed.profile.capability.digest);
    expect(profileFixtures.multiRung.capability.rungs).toHaveLength(5);
  });

  it("runs smoke/calibration reports with observed bindings, cache fields, and profile-relative metrics", async () => {
    const executor = await PiSessionExecutor.create({});
    const smoke = await runCandidateMatrix(syntheticManifest, executor, { corpusMode: "smoke" });
    const runs = await runCandidateMatrix(syntheticManifest, executor, { corpusMode: "calibration" });
    expect(smoke.length).toBeGreaterThan(0); expect(runs.every((run) => run.expected.provenance === "synthetic-oracle")).toBe(true);
    const metrics = summarizeEvaluation(syntheticManifest, runs); const report = renderMarkdownReport(syntheticManifest, runs, metrics, syntheticCacheCrossover, []);
    for (const text of ["synthetic fixtures only", "cache read", "cache write", "Observed production routing", "Traceable human review", "Metadata-only selectors", "requestKey=", "provider latency ms", "unavailable", "source="]) expect(report).toContain(text);
    expect(metrics.profileRelativeArmCount).toBeGreaterThan(0);
    expect(metrics.byMode.policy?.costObservations).toBe(0);
    expect(metrics.byMode.policy?.providerLatencyObservations).toBe(0);
    expect(metrics.byMode.policy?.retryObservations).toBe(0);
  });

  it("drives calibration initial selectors through prompts instead of reusing the corpus description", async () => {
    const executor = await PiSessionExecutor.create({});
    const runs = await runEvaluation(syntheticManifest, executor, { corpusMode: "calibration", repetitions: 1 });
    const two = runs.filter((run) => run.taskId === "cal-two" && run.result.observed.kind === "observed").map((run) => run.result.observed.kind === "observed" ? run.result.observed.routing.selected?.rungId : undefined);
    const multi = runs.filter((run) => run.taskId === "cal-multi" && run.result.observed.kind === "observed").map((run) => run.result.observed.kind === "observed" ? run.result.observed.routing.selected?.rungId : undefined);
    expect(new Set(two)).toEqual(new Set(["economy", "deliberate"]));
    expect(new Set(multi)).toEqual(new Set(["low", "mid", "high", "max-auto"]));
  });

  it("drives and correlates all six production evidence triggers through post-evidence provider requests", async () => {
    const executor = await PiSessionExecutor.create({}); const task = syntheticManifest.tasks.find((value) => value.id === "cal-multi")!;
    for (const trigger of evidenceTriggers) {
      const selector = task.profile.admission.evidence[trigger].selector;
      const result = await executor.execute(task, { mode: "automatic", selector, requestedRungId: "max-auto", scenario: scenarioForEvidence(trigger) });
      expect(result.evidence?.trigger).toBe(trigger); expect(result.observed.kind).toBe("observed");
      if (!result.evidence || result.observed.kind !== "observed") continue;
      const before = result.evidence.before; const after = result.evidence.after;
      expect(observedRequestKeyIdentity(before.request.key)).not.toBe(observedRequestKeyIdentity(after.request.key));
      if (before.request.key.epochId === after.request.key.epochId) expect(after.request.key.requestIndex).toBeGreaterThan(before.request.key.requestIndex);
      else expect(trigger).toBe("failedContinuation");
      expect(after.routing.escalation).toEqual({ selector, rung: { rungId: "max-auto", ordinal: 3, providerValue: "xhigh" } });
      expect(after.routing.effective).toEqual({ rungId: "max-auto", ordinal: 3, providerValue: "xhigh" });
      expect(after.request).toMatchObject({ patchStatus: "shadow" });
      expect(after.request.locallyAppliedProviderValue).toBeUndefined();
      expect(result.providerRequests).toBe(2); expect(result.toolRounds).toBe(trigger === "repeatedToolError" ? 2 : trigger === "firstToolError" ? 1 : 0);
    }
  });

  it("declares only executable classifier scenarios for automatic arms", () => {
    const multi = comparisonArms(syntheticManifest.tasks.find((task) => task.id === "cal-multi")!);
    expect(multi.filter((arm) => arm.mode === "automatic" || arm.mode === "anchor").every((arm) => arm.scenario?.prompt !== "Debug this failure.")).toBe(true);
  });

  it("rejects corrupt JSONL as observed evidence", () => {
    const directory = mkdtempSync(join(process.cwd(), "eval", ".tmp-corrupt-"));
    try { writeFileSync(join(directory, "decisions.jsonl"), "{not-json}\n"); expect(observeTelemetry(directory, undefined)).toEqual({ kind: "unavailable", reason: "malformed-telemetry" }); } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("observes the baseline arm as a shadow request rather than a fabricated baseline selection", async () => {
    const executor = await PiSessionExecutor.create({}); const task = syntheticManifest.tasks.find((value) => value.id === "regression-two")!;
    const result = await executor.execute(task, { mode: "baseline" });
    expect(result.expected.baselineArm).toBe(true); expect(result.observed.kind).toBe("observed");
    if (result.observed.kind === "observed") { expect(result.observed.request.patchStatus).toBe("shadow"); expect(result.observed.routing.effective?.rungId).toBe("economy"); }
  });

  it("rejects ambiguous JSONL sets instead of selecting a record by position", () => {
    const directory = mkdtempSync(join(process.cwd(), "eval", ".tmp-ambiguous-"));
    try { writeFileSync(join(directory, "decisions.jsonl"), `${JSON.stringify({ schemaVersion: 1 })}\n${JSON.stringify({ schemaVersion: 1 })}\n`); expect(observeTelemetry(directory, undefined)).toEqual({ kind: "unavailable", reason: "malformed-telemetry" }); } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("uses the emitted composite request key, rejects duplicate/cross-session/corrupt identity, and preserves absent versus zero", async () => {
    const executor = await PiSessionExecutor.create({}); const task = syntheticManifest.tasks.find((value) => value.id === "regression-two")!;
    const seed = await executor.execute(task, { mode: "policy" }); expect(seed.observed.kind).toBe("observed"); if (seed.observed.kind !== "observed") return;
    const profile = seed.observed.profile;
    const decision = { schemaVersion: 1, sessionHash: "session-a", epochId: "epoch-a", decisionId: "decision-a", profile };
    const request = { schemaVersion: 1, sessionHash: "session-a", epochId: "epoch-a", requestIndex: 1, decisionId: "decision-a", profile, patchStatus: "applied", locallyAppliedProviderValue: "minimal", provider: profile.model.provider, api: profile.model.api, model: profile.model.model, inputTokens: 0, cacheReadTokens: 0, latencyMs: 0 };
    const epoch = { schemaVersion: 1, sessionHash: "session-a", epochId: "epoch-a", requestCount: 1, status: "settled", profile };
    const hook = { reasoning: { effort: "minimal" } };
    const observed = parseRows([decision], [request], [epoch], hook); expect(observed.kind).toBe("observed"); if (observed.kind !== "observed") return;
    expect(observed.request.key).toEqual({ sessionHash: "session-a", epochId: "epoch-a", requestIndex: 1 });
    expect(observed.request.usage).toHaveProperty("cacheReadTokens", 0); expect(observed.request.usage).not.toHaveProperty("cacheWriteTokens"); expect(observed.request.usage).not.toHaveProperty("cost");
    expect(observed.request.telemetryLifecycleLatencyMs).toBe(0);
    expect(parseRows([decision], [request, request], [epoch], hook)).toEqual({ kind: "unavailable", reason: "ambiguous-telemetry" });
    expect(observedRequestKeyIdentity({ sessionHash: "session-a", epochId: "epoch-a", requestIndex: 1 })).not.toBe(observedRequestKeyIdentity({ sessionHash: "session-b", epochId: "epoch-a", requestIndex: 1 }));
    expect(parseRows([decision], [{ ...request, sessionHash: "session-b" }], [epoch], hook)).toEqual({ kind: "unavailable", reason: "ambiguous-telemetry" });
    expect(parseRows([decision], [{ ...request, model: "wrong-model" }], [epoch], hook)).toEqual({ kind: "unavailable", reason: "ambiguous-telemetry" });
    expect(parseRows([decision], [request], [{ ...epoch, requestCount: 2 }], hook)).toEqual({ kind: "unavailable", reason: "ambiguous-telemetry" });
    for (const corrupt of [{ ...request, sessionHash: "" }, { ...request, requestIndex: -1 }, { ...request, requestIndex: 1.5 }, { ...request, decisionId: "" }, { ...request, patchStatus: "invented" }, { ...request, cacheReadTokens: -1 }]) {
      expect(parseRows([decision], [corrupt], [epoch], hook)).toEqual({ kind: "unavailable", reason: "malformed-telemetry" });
    }
  });

  it("keeps provider values faithful to the exact observed rung in manual and mismatched-rung telemetry", async () => {
    const executor = await PiSessionExecutor.create({}); const task = syntheticManifest.tasks.find((value) => value.id === "regression-multi")!;
    const manual = await executor.execute(task, { mode: "manual-diagnostic", requestedRungId: "manual", scenario: { kind: "initial", admissionCase: "boundedRead", prompt: "Explain this file." } });
    expect(manual.observed.kind).toBe("observed"); if (manual.observed.kind !== "observed") return;
    expect(manual.observed.routing.selected).toEqual({ rungId: "low", ordinal: 0 });
    expect(manual.observed.routing.effective).toEqual({ rungId: "manual", ordinal: 4, providerValue: "max" });
    expect(manual.observed.routing.manual).toEqual({ rungId: "manual", ordinal: 4, providerValue: "max" });
    expect(JSON.stringify(manual.observed.routing.selected)).not.toContain("max");
    const profile = { ...manual.observed.profile, requested: { rungId: "low", ordinal: 0 }, effective: { rungId: "manual", ordinal: 4 }, manual: { rungId: "manual", ordinal: 4 }, resolved: { rungId: "manual", ordinal: 4, providerValue: "max" } };
    const decision = { schemaVersion: 1, sessionHash: "session-manual", epochId: "epoch-manual", decisionId: "decision-manual", profile };
    const request = { schemaVersion: 1, sessionHash: "session-manual", epochId: "epoch-manual", requestIndex: 1, decisionId: "decision-manual", profile, patchStatus: "applied", locallyAppliedProviderValue: "max", provider: profile.model.provider, api: profile.model.api, model: profile.model.model };
    const epoch = { schemaVersion: 1, sessionHash: "session-manual", epochId: "epoch-manual", requestCount: 1, status: "settled", profile };
    const parsed = parseRows([decision], [request], [epoch], { reasoning: { effort: "max" } }); expect(parsed.kind).toBe("observed"); if (parsed.kind !== "observed") return;
    expect(parsed.routing.selected).toEqual({ rungId: "low", ordinal: 0 }); expect(parsed.routing.effective?.providerValue).toBe("max"); expect(parsed.routing.manual?.providerValue).toBe("max");
  });

  it("rejects automatic arms whose real lifecycle observation is unavailable or mismatched", async () => {
    const task = syntheticManifest.tasks.find((value) => value.id === "regression-two")!;
    const unavailable: EvaluationExecutor = { execute: async () => ({ expected: { baselineArm: false, expectedOutput: task.expectedOutput, provenance: "synthetic-oracle" }, observed: { kind: "unavailable", reason: "no-telemetry" }, activationBoundary: "factory-activation", providerRequests: 1, toolRounds: 0, harnessLatencyMs: 0 }) };
    await expect(runEvaluation({ ...syntheticManifest, tasks: [task] }, unavailable, { repetitions: 1 })).rejects.toThrow("did not produce observable evidence");
    const real = await PiSessionExecutor.create({});
    const mismatched: EvaluationExecutor = { execute: async (value, request) => { const result = await real.execute(value, request); return result.observed.kind === "observed" && (request.mode === "automatic" || request.mode === "anchor") ? { ...result, observed: { ...result.observed, routing: { ...result.observed.routing, selected: { rungId: "wrong", ordinal: 0 } } } } : result; } };
    await expect(runEvaluation({ ...syntheticManifest, tasks: [task] }, mismatched, { repetitions: 1 })).rejects.toThrow("did not produce its declared automatic arm");
  });

  it("calibrates traceable accept, reject, and inconclusive reviewer cases against exact run/task identities", async () => {
    const executor = await PiSessionExecutor.create({}); const task = syntheticManifest.tasks.find((value) => value.id === "regression-two")!;
    const [run] = await runEvaluation({ ...syntheticManifest, tasks: [task] }, executor, { repetitions: 1 }); expect(run).toBeDefined(); if (!run) return;
    if (run.result.observed.kind !== "observed") throw new Error("synthetic review run must be observed");
    const profile = canonicalProfileDigest(run.result.observed.profile); if (!profile.ok) throw new Error("synthetic review profile must be canonical");
    const review = (acceptance: HumanReviewDecision["acceptance"]): HumanReviewDecision => ({ runId: run.id, taskId: run.taskId, reviewer: "synthetic-reviewer", reviewedAt: "2026-01-01T00:00:00Z", acceptance, criticalFailure: acceptance === "reject", evidenceReference: `synthetic://review/${acceptance}`, rationale: `synthetic ${acceptance} calibration`, profileDigest: profile.digest, reportDigest: "a".repeat(64), sourceFingerprint: "b".repeat(64), extensionBuildFingerprint: "c".repeat(64) });
    expect(() => validateHumanReviewDecisions([review("accept"), review("reject"), review("inconclusive")], [run])).not.toThrow();
    expect(() => validateHumanReviewDecisions([{ ...review("accept"), taskId: "wrong-task" }], [run])).toThrow("does not match");
    expect(() => validateHumanReviewDecisions([{ ...review("accept"), runId: "" }], [run])).toThrow("not traceable");
  });

  it("keeps one factory session across settled reset, continuation, manual, ambiguity, and replacement", async () => {
    const executor = await PiSessionExecutor.create({});
    const records = await executor.sameSessionLifecycle(syntheticManifest.tasks.find((task) => task.profile.name === "multi-rung")!);
    const requests = records.filter((record) => "patchStatus" in record); const decisions = records.filter((record) => "decisionId" in record && "features" in record);
    expect(decisions.length).toBeGreaterThan(4); expect(requests.some((record) => record.correlationError === "ambiguous_response")).toBe(true);
    expect(new Set(requests.map((record) => record.sessionHash)).size).toBeGreaterThan(1);
    const first = decisions[0] as { profile: { requested: { rungId: string; ordinal: number }; resolved: { providerValue: string } } };
    expect(first.profile.requested).toEqual({ rungId: "mid", ordinal: 1 }); expect(first.profile.resolved.providerValue).toBe("medium");
    const continuation = decisions.find((record) => record.relation === "continuation") as { profile: { requested?: { rungId: string; ordinal: number } } } | undefined;
    expect(continuation?.profile.requested).toEqual({ rungId: "high", ordinal: 2 });
    expect(decisions.filter((record) => record.relation === "continuation").length).toBeGreaterThanOrEqual(3);
    expect(requests.some((record) => record.stopReason === "error")).toBe(true);
    expect(requests.some((record) => record.stopReason === "length")).toBe(true);
    expect(requests.every((record) => record.patchStatus === "shadow")).toBe(true);
    expect(requests.filter((record) => record.decisionId !== undefined).every((record) => typeof record.epochId === "string" && typeof record.sessionHash === "string")).toBe(true);
    expect(JSON.stringify(records)).not.toContain("synthetic feature.");
  });
});
