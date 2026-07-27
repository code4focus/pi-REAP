import { createProfileBinding, resolveAutomaticRung } from "../../src/domain/profile.js";
import type { CorpusManifest, CorpusMode, CorpusTask } from "../corpus/types.js";
import { gradeDeterministically } from "../graders/deterministic.js";
import { observedEffectiveCostMicros, syntheticTokenPricing, type TokenPricing } from "./cost.js";
import type { ArmAlias, EvaluationExecutor, EvaluationRun, EvidenceLifecycleScenario, EvidenceTrigger, ExecutionRequest, InitialAdmissionCase, InitialLifecycleScenario, LifecycleScenario } from "./types.js";
export interface RunnerOptions { readonly repetitions: number; readonly corpusMode?: CorpusMode; readonly pricing?: TokenPricing }
export interface CandidateMatrixOptions { readonly corpusMode: "smoke" | "calibration"; readonly repetitions?: number; readonly pricing?: TokenPricing }
export interface MetadataOnlyArm { readonly mode: "metadata-only"; readonly alias: ArmAlias; readonly requestedRungId: string; readonly reason: "no-production-lifecycle-driver" }
const initialCases: readonly InitialAdmissionCase[] = ["simpleQuery", "boundedRead", "implementation", "debugging", "architecture", "highRisk", "continuation", "unknown"];
export const evidenceTriggers: readonly EvidenceTrigger[] = ["firstToolError", "repeatedToolError", "providerError", "lengthExhaustion", "overflowRetry", "failedContinuation"];
const scenarioForInitial = (admissionCase: InitialAdmissionCase): InitialLifecycleScenario => ({
  kind: "initial", admissionCase,
  prompt: admissionCase === "simpleQuery" ? "What is JSON?" : admissionCase === "boundedRead" ? "Explain this file." : admissionCase === "implementation" ? "Implement this feature." : admissionCase === "debugging" ? "Debug this failure." : admissionCase === "architecture" ? "Plan this goal." : admissionCase === "highRisk" ? "Assess this security permission." : admissionCase === "continuation" ? "continue" : "opaque request",
});
export const scenarioForEvidence = (trigger: EvidenceTrigger): EvidenceLifecycleScenario => ({ kind: "evidence", trigger, initialPrompt: "Implement this feature.", followupPrompt: trigger === "failedContinuation" ? "continue" : "provider retry", toolErrors: trigger === "firstToolError" ? 1 : trigger === "repeatedToolError" ? 2 : 0 });
const selectorIdentity = (value: unknown): string => JSON.stringify(value);
interface ArmDraft { readonly rungId: string; readonly ordinal: number; readonly providerValue: unknown; readonly aliases: ArmAlias[]; selector?: ExecutionRequest["selector"]; scenario?: LifecycleScenario }
function armDrafts(task: CorpusTask): { readonly binding: ReturnType<typeof createProfileBinding>; readonly drafts: ArmDraft[] } | undefined {
  const binding = createProfileBinding(task.profile.capability, task.profile.admission); if (!binding.ok) return undefined;
  const drafts = new Map<string, ArmDraft>();
  const add = (selector: NonNullable<ExecutionRequest["selector"]>, alias: ArmAlias, scenario: LifecycleScenario | undefined) => {
    const resolved = resolveAutomaticRung(task.profile.capability, task.profile.admission, selector); if (!resolved) return;
    const providerValue = task.profile.capability.rungs.find((value) => value.id === resolved.rungId)?.providerValue;
    const identity = JSON.stringify([binding.binding.capability.profileId, binding.binding.capability.profileRevision, binding.binding.capability.profileDigest, binding.binding.admission.profileId, binding.binding.admission.profileRevision, binding.binding.admission.profileDigest, resolved.rungId, resolved.ordinal, providerValue]);
    const draft = drafts.get(identity) ?? { rungId: resolved.rungId, ordinal: resolved.ordinal, providerValue, aliases: [] };
    draft.aliases.push(alias);
    if (scenario !== undefined && draft.scenario === undefined) { draft.scenario = scenario; draft.selector = selector; }
    drafts.set(identity, draft);
  };
  for (const admissionCase of initialCases) {
    const selector = task.profile.admission.initial[admissionCase]; const reachable = admissionCase !== "debugging";
    add(selector, { source: "initial", admissionCase, selector, reachable }, reachable ? scenarioForInitial(admissionCase) : undefined);
  }
  for (const trigger of evidenceTriggers) {
    const selector = task.profile.admission.evidence[trigger].selector;
    add(selector, { source: "evidence", trigger, selector, reachable: true }, scenarioForEvidence(trigger));
  }
  return { binding, drafts: [...drafts.values()] };
}
export function comparisonArms(task: CorpusTask): readonly ExecutionRequest[] {
  const baseline = { mode: "baseline", scenario: scenarioForInitial("simpleQuery") } as const;
  if (task.profileState && task.profileState !== "resolved") return [baseline];
  const resolved = armDrafts(task); if (!resolved) return [baseline];
  const arms: ExecutionRequest[] = [baseline, { mode: "policy", scenario: scenarioForInitial("simpleQuery") }];
  for (const draft of resolved.drafts) if (draft.scenario && draft.selector) {
    const selectorAliases = [...new Map(draft.aliases.map((alias) => [selectorIdentity(alias.selector), alias.selector])).values()];
    arms.push({ mode: draft.selector.kind === "anchor" ? "anchor" : "automatic", selector: draft.selector, requestedRungId: draft.rungId, selectorAliases, armAliases: draft.aliases, scenario: draft.scenario });
  }
  for (const rung of task.profile.capability.rungs) if (rung.explicitOnly) arms.push({ mode: "manual-diagnostic", requestedRungId: rung.id, scenario: scenarioForInitial("boundedRead") });
  return arms;
}
/** Declares profile selectors that have no faithful production lifecycle driver; these are never executed as comparison evidence. */
export function metadataOnlyArms(task: CorpusTask): readonly MetadataOnlyArm[] {
  if (task.profileState && task.profileState !== "resolved") return [];
  const resolved = armDrafts(task); if (!resolved) return [];
  return resolved.drafts.flatMap((draft) => draft.aliases.filter((alias) => !alias.reachable).map((alias) => ({ mode: "metadata-only" as const, alias, requestedRungId: draft.rungId, reason: "no-production-lifecycle-driver" as const })));
}
async function one(task: CorpusTask, executor: EvaluationExecutor, request: ExecutionRequest, repetition: number, pricing: TokenPricing): Promise<EvaluationRun> {
  const result = await executor.execute(task, request);
  const observed = result.observed;
  if (request.mode === "automatic" || request.mode === "anchor") {
    if (observed.kind !== "observed") throw new Error(`lifecycle scenario ${request.scenario?.kind === "evidence" ? request.scenario.trigger : request.scenario?.kind ?? "missing"} did not produce observable evidence for ${request.mode} arm: ${observed.reason}`);
    const expectedProvider = task.profile.capability.rungs.find((rung) => rung.id === request.requestedRungId)?.providerValue;
    if (request.scenario?.kind === "evidence") {
      const escalation = observed.routing.escalation;
      if (result.evidence?.trigger !== request.scenario.trigger || !escalation || selectorIdentity(escalation.selector) !== selectorIdentity(request.selector) || escalation.rung.rungId !== request.requestedRungId || escalation.rung.ordinal !== task.profile.capability.rungs.find((rung) => rung.id === request.requestedRungId)?.ordinal || escalation.rung.providerValue !== expectedProvider || observed.routing.effective?.rungId !== request.requestedRungId || observed.routing.effective.providerValue !== expectedProvider || selectorIdentity(result.evidence.after.request.key) === selectorIdentity(result.evidence.before.request.key)) throw new Error(`lifecycle evidence did not produce its declared arm: ${request.scenario.trigger} => ${JSON.stringify(observed.routing)}`);
    } else if (!request.selectorAliases?.some((selector) => selectorIdentity(selector) === selectorIdentity(observed.routing.selector)) || observed.routing.selected?.rungId !== request.requestedRungId || observed.routing.selected?.providerValue !== expectedProvider) throw new Error(`lifecycle scenario did not produce its declared automatic arm: ${request.scenario?.kind === "initial" ? request.scenario.prompt : "missing"} => ${JSON.stringify(observed.routing)}`);
  }
  if (request.mode === "manual-diagnostic" && request.requestedRungId) {
    if (result.observed.kind !== "observed") throw new Error(`${request.mode} did not produce observable evidence`);
    if (result.observed.routing.manual?.rungId !== request.requestedRungId) throw new Error(`${request.mode} observed a different manual rung`);
  }
  const effectiveCostMicros = observed.kind === "observed" ? observedEffectiveCostMicros(observed.request.usage, pricing) : undefined;
  const run = { id: `${task.id}:${request.mode}:${request.requestedRungId ?? "baseline"}:${repetition}`, taskId: task.id, mode: request.mode, repetition, expected: result.expected, ...(request.selectorAliases ? { selectorAliases: request.selectorAliases } : {}), ...(request.armAliases ? { armAliases: request.armAliases } : {}), result, ...(effectiveCostMicros === undefined ? {} : { effectiveCostMicros }) } satisfies Omit<EvaluationRun, "grade">;
  return { ...run, grade: gradeDeterministically(task, run) };
}
export async function runEvaluation(manifest: CorpusManifest, executor: EvaluationExecutor, options: RunnerOptions): Promise<EvaluationRun[]> { if (!Number.isInteger(options.repetitions) || options.repetitions < 1) throw new Error("repetitions must be at least one"); const tasks = manifest.tasks.filter((t) => !options.corpusMode || t.mode === options.corpusMode); const runs: EvaluationRun[] = []; for (const task of tasks) for (const arm of comparisonArms(task)) for (let i = 1; i <= options.repetitions; i += 1) runs.push(await one(task, executor, arm, i, options.pricing ?? syntheticTokenPricing)); return runs; }
export async function runCandidateMatrix(manifest: CorpusManifest, executor: EvaluationExecutor, options: CandidateMatrixOptions): Promise<EvaluationRun[]> { const requirement = manifest.stages[options.corpusMode]; const tasks = manifest.tasks.filter((t) => t.mode === options.corpusMode); if (tasks.length < requirement.minimumTasks) throw new Error(`${options.corpusMode} has insufficient tasks`); return runEvaluation({ ...manifest, tasks }, executor, { corpusMode: options.corpusMode, repetitions: options.repetitions ?? requirement.repetitions, ...(options.pricing ? { pricing: options.pricing } : {}) }); }
