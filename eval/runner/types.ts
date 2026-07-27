import type { RungSelector } from "../../src/domain/profile.js";
import type { ProfileObservation } from "../../src/telemetry/records.js";
import type { CorpusTask } from "../corpus/types.js";
import type { Grade } from "../graders/deterministic.js";

export type EvaluationMode = "baseline" | "automatic" | "anchor" | "manual-diagnostic" | "policy";
export type ActivationBoundary = "factory-activation" | "missing-activation" | "live-context-mismatch";
export type InitialAdmissionCase = "simpleQuery" | "boundedRead" | "implementation" | "debugging" | "architecture" | "highRisk" | "continuation" | "unknown";
export type EvidenceTrigger = "firstToolError" | "repeatedToolError" | "providerError" | "lengthExhaustion" | "overflowRetry" | "failedContinuation";
export interface InitialLifecycleScenario { readonly kind: "initial"; readonly admissionCase: InitialAdmissionCase; readonly prompt: string }
export interface EvidenceLifecycleScenario { readonly kind: "evidence"; readonly trigger: EvidenceTrigger; readonly initialPrompt: string; readonly followupPrompt: string; readonly toolErrors: 0 | 1 | 2 }
/** Executable lifecycle input; corpus labels and desired rungs are intentionally absent. */
export type LifecycleScenario = InitialLifecycleScenario | EvidenceLifecycleScenario;
export type ArmAlias =
  | { readonly source: "initial"; readonly admissionCase: InitialAdmissionCase; readonly selector: RungSelector; readonly reachable: boolean }
  | { readonly source: "evidence"; readonly trigger: EvidenceTrigger; readonly selector: RungSelector; readonly reachable: true };
export interface UsageMetrics { readonly inputTokens?: number; readonly uncachedInputTokens?: number; readonly outputTokens?: number; readonly reasoningTokens?: number; readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number; readonly cost?: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number; readonly total: number } }
/** Complete counters required only by bounded live qualification artifacts. */
export interface MeasuredUsage extends UsageMetrics { readonly inputTokens: number; readonly uncachedInputTokens: number; readonly outputTokens: number; readonly reasoningTokens: number; readonly cacheReadTokens: number; readonly cacheWriteTokens: number }
export interface ExecutionRequest { readonly mode: EvaluationMode; readonly selector?: RungSelector; readonly requestedRungId?: string; readonly selectorAliases?: readonly RungSelector[]; readonly armAliases?: readonly ArmAlias[]; readonly scenario?: LifecycleScenario }

/** Corpus oracle only; it is deliberately unable to stand in for production evidence. */
export interface ExpectedComparison { readonly baselineArm: boolean; readonly expectedOutput: string; readonly provenance: "synthetic-oracle" }
export interface ObservedRung { readonly rungId: string; readonly ordinal: number; readonly providerValue?: string }
export interface ObservedRouting { readonly selector?: RungSelector; readonly selected?: ObservedRung; readonly effective?: ObservedRung; readonly manual?: ObservedRung; readonly escalation?: { readonly selector: RungSelector; readonly rung: ObservedRung }; readonly providerValue?: string }
/** The production telemetry schema scopes requestIndex to one epoch and epochId to one session. */
export interface ObservedRequestKey { readonly sessionHash: string; readonly epochId: string; readonly requestIndex: number }
export interface ObservedRequest {
  readonly key: ObservedRequestKey;
  readonly patchStatus: "shadow" | "applied" | "unsupported" | "invalid_payload" | "mapping_failed";
  readonly locallyAppliedProviderValue?: string;
  readonly originalEffort?: string;
  /** Genuine production decision link when one was emitted; never a derived request identity. */
  readonly decisionId?: string;
  readonly provider: string;
  readonly api: string;
  readonly model: string;
  readonly usage: UsageMetrics;
  /** Raw PR4 hook-to-message lifecycle measurement, not a provider latency claim. */
  readonly telemetryLifecycleLatencyMs?: number;
}
export interface ObservedProduction {
  readonly kind: "observed";
  readonly profile: ProfileObservation;
  readonly routing: ObservedRouting;
  readonly request: ObservedRequest;
  /** A separately named synthetic provider response observed through message_end. */
  readonly output?: { readonly value: string; readonly provenance: "synthetic-provider-lifecycle" };
  readonly epoch: { readonly id: string; readonly status: string; readonly requestCount: number };
}
export interface UnavailableProduction { readonly kind: "unavailable"; readonly reason: "no-telemetry" | "malformed-telemetry" | "ambiguous-telemetry" | "fail-closed" }
export type ProductionObservation = ObservedProduction | UnavailableProduction;
export interface ExecutionResult {
  readonly expected: ExpectedComparison;
  readonly observed: ProductionObservation;
  readonly activationBoundary: ActivationBoundary;
  /** Counts measured by the local lifecycle harness. */
  readonly providerRequests: number;
  readonly toolRounds: number;
  readonly harnessLatencyMs: number;
  /** Omitted unless the provider supplies these measurements. */
  readonly providerLatencyMs?: number;
  readonly retries?: number;
  readonly evidence?: {
    readonly trigger: EvidenceTrigger;
    readonly before: ObservedProduction;
    readonly after: ObservedProduction;
  };
}
export interface EvaluationRun { readonly id: string; readonly taskId: string; readonly mode: EvaluationMode; readonly repetition: number; readonly expected: ExpectedComparison; readonly selectorAliases?: readonly RungSelector[]; readonly armAliases?: readonly ArmAlias[]; readonly result: ExecutionResult; readonly effectiveCostMicros?: number; readonly grade: Grade }
export interface EvaluationExecutor { execute(task: CorpusTask, request: ExecutionRequest): Promise<ExecutionResult> }
