import type { Effort } from "../domain/effort.js";
import type { ReasonCode, RoutingFeatures } from "../domain/routing-decision.js";
import type { TaskClass } from "../domain/task-epoch.js";

export interface DecisionRecord {
  schemaVersion: 1;
  policyVersion: string;
  sessionHash: string;
  epochId: string;
  decisionId: string;
  relation: "new" | "continuation" | "ambiguous";
  taskClass: TaskClass;
  recommendedEffort: Effort;
  /** Absent when shadow mode cannot observe a trustworthy baseline effort. */
  appliedEffort?: Effort;
  mode: "shadow" | "enforce";
  promptHash: string;
  promptChars: number;
  features: RoutingFeatures;
  reasons: ReasonCode[];
  timestamp: number;
}

export interface RequestRecord {
  schemaVersion: 1;
  sessionHash: string;
  epochId: string;
  requestIndex: number;
  provider: string;
  api: string;
  model: string;
  originalEffort?: string;
  appliedEffort?: string;
  patchStatus: "shadow" | "applied" | "unsupported" | "invalid_payload" | "mapping_failed" | "policy_failed";
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  stopReason?: string;
  latencyMs?: number;
  correlationError?: "missing_pending_request" | "unsettled_request" | "concurrent_pending_request";
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
}
