import type { Effort } from "../domain/effort.js";
import type { RoutingDecision } from "../domain/routing-decision.js";
import type { TaskEpoch } from "../domain/task-epoch.js";
import type { ProviderModel } from "../provider/patch.js";
import { TelemetryWriter } from "./writer.js";

interface PendingRequest { epochId: string; requestIndex: number; provider: string; api: string; model: string; originalEffort?: string; appliedEffort?: string; patchStatus: "shadow" | "applied" | "unsupported" | "invalid_payload" | "mapping_failed" | "policy_failed"; startedAt: number; }
export interface Usage { inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }

/** Correlates serial lifecycle events without retaining request content. */
export class TelemetryRuntime {
  private readonly pending: PendingRequest[] = [];
  constructor(readonly writer: TelemetryWriter) {}

  decision(decision: RoutingDecision, promptChars: number, mode: "shadow" | "enforce", recommendedEffort: Effort, appliedEffort: Effort | undefined, promptHash: string): void {
    this.writer.writeDecision({ schemaVersion: 1, policyVersion: decision.policyVersion, sessionHash: this.writer.sessionHash, epochId: decision.epochId, decisionId: decision.id, relation: decision.relation, taskClass: decision.taskClass, recommendedEffort, ...(appliedEffort ? { appliedEffort } : {}), mode, promptHash, promptChars, features: decision.features, reasons: decision.reasons, timestamp: decision.timestamp });
  }

  request(epoch: TaskEpoch, model: (ProviderModel & { id?: unknown; provider?: unknown }) | undefined, payload: unknown, mode: "shadow" | "enforce", recommendedEffort: Effort, appliedEffort: Effort | undefined, patched: boolean): void {
    const originalEffort = effortIn(payload);
    if (this.pending.length > 0) this.writer.writeRequest({ schemaVersion: 1, sessionHash: this.writer.sessionHash, epochId: epoch.id, requestIndex: epoch.requestCount, provider: typeof model?.provider === "string" ? model.provider : "unknown", api: typeof model?.api === "string" ? model.api : "unknown", model: typeof model?.id === "string" ? model.id : "unknown", patchStatus: "policy_failed", correlationError: "concurrent_pending_request" });
    this.pending.push({ epochId: epoch.id, requestIndex: epoch.requestCount, provider: typeof model?.provider === "string" ? model.provider : "unknown", api: typeof model?.api === "string" ? model.api : "unknown", model: typeof model?.id === "string" ? model.id : "unknown", ...(originalEffort ? { originalEffort } : {}), ...(appliedEffort !== undefined ? { appliedEffort } : {}), patchStatus: mode === "shadow" ? "shadow" : patched ? "applied" : "unsupported", startedAt: this.writer.timestamp() });
    void recommendedEffort;
  }

  response(stopReason: string | undefined, usage?: Usage): void {
    const pending = this.pending.shift();
    if (!pending) { this.writer.writeRequest({ schemaVersion: 1, sessionHash: this.writer.sessionHash, epochId: "unknown", requestIndex: 0, provider: "unknown", api: "unknown", model: "unknown", patchStatus: "policy_failed", correlationError: "missing_pending_request" }); return; }
    this.writer.writeRequest({ schemaVersion: 1, sessionHash: this.writer.sessionHash, epochId: pending.epochId, requestIndex: pending.requestIndex, provider: pending.provider, api: pending.api, model: pending.model, ...(pending.originalEffort ? { originalEffort: pending.originalEffort } : {}), ...(pending.appliedEffort ? { appliedEffort: pending.appliedEffort } : {}), patchStatus: pending.patchStatus, ...usage, ...(stopReason ? { stopReason } : {}), latencyMs: this.writer.timestamp() - pending.startedAt });
  }

  epoch(epoch: TaskEpoch): void { this.writer.writeEpoch({ schemaVersion: 1, sessionHash: this.writer.sessionHash, epochId: epoch.id, status: epoch.status, taskClass: epoch.taskClass, requestCount: epoch.requestCount, toolCallCount: epoch.toolCallCount, toolErrorCount: epoch.toolErrorCount, providerErrorCount: epoch.providerErrorCount, startedAt: epoch.createdAt, endedAt: epoch.lastActivityAt }); }
  flushUnsettled(): void {
    for (const pending of this.pending.splice(0)) this.writer.writeRequest({ schemaVersion: 1, sessionHash: this.writer.sessionHash, epochId: pending.epochId, requestIndex: pending.requestIndex, provider: pending.provider, api: pending.api, model: pending.model, patchStatus: pending.patchStatus, correlationError: "unsettled_request" });
  }
}

function effortIn(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const reasoning = (payload as Record<string, unknown>).reasoning;
  return typeof reasoning === "object" && reasoning !== null && !Array.isArray(reasoning) && typeof (reasoning as Record<string, unknown>).effort === "string" ? (reasoning as Record<string, string>).effort : undefined;
}
