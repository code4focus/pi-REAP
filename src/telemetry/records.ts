import type { ReasonCode, RoutingFeatures } from "../domain/routing-decision.js";
import type { RungSelector } from "../domain/profile.js";
import type { TaskClass } from "../domain/task-epoch.js";

export interface ProfileObservation { capability: { id: string; revision: string; digest: string; source: unknown }; admission: { id: string; revision: string; digest: string; source: unknown }; model: { provider: string; api: string; model: string; catalogRevision: string; catalogDigest: string; piVersion: string; adapterRevision: string; adapterDigest: string }; /** Selector is retained independently so equal rungs are not conflated. */ selector?: RungSelector; resolved?: { rungId: string; ordinal: number; providerValue?: string }; requested?: { rungId: string; ordinal: number }; effective?: { rungId: string; ordinal: number }; manual?: { rungId: string; ordinal: number }; escalation?: { selector: RungSelector; rungId: string; ordinal: number }; generation: number; }

export interface DecisionRecord {
  schemaVersion: 1;
  policyVersion: string;
  sessionHash: string;
  epochId: string;
  decisionId: string;
  relation: "new" | "continuation" | "ambiguous";
  taskClass: TaskClass;
  profile?: ProfileObservation;
  /** Absent when shadow mode cannot observe a trustworthy baseline effort. */
  /** Provider-specific effort actually written by this extension; not wire-final truth. */
  appliedProviderValue?: string;
  mode: "shadow" | "enforce";
  promptHash: string;
  promptChars: number;
  /** Present only after the explicit telemetry.includePromptText opt-in. */
  promptText?: string;
  /** Present only when the user explicitly enabled prompt-text telemetry. */
  features: RoutingFeatures;
  reasons: ReasonCode[];
  timestamp: number;
}

export interface RequestRecord {
  schemaVersion: 1;
  sessionHash: string;
  epochId: string;
  requestIndex: number;
  decisionId?: string;
  provider: string;
  api: string;
  model: string;
  profile?: ProfileObservation;
  originalEffort?: string;
  locallyAppliedProviderValue?: string;
  patchStatus: "shadow" | "applied" | "unsupported" | "invalid_payload" | "mapping_failed";
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  stopReason?: string;
  latencyMs?: number;
  correlationError?: "missing_pending_request" | "unsettled_request" | "concurrent_pending_request" | "ambiguous_response" | "no_decision" | "session_boundary" | "profile_boundary" | "settled_boundary";
}

export interface EpochRecord {
  schemaVersion: 1;
  sessionHash: string;
  epochId: string;
  status: "active" | "settled" | "failed" | "retired";
  taskClass: TaskClass;
  requestCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  providerErrorCount: number;
  startedAt: number;
  endedAt: number;
  profile?: ProfileObservation;
}
