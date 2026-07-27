import type { RoutingDecision } from "../domain/routing-decision.js";
import type { TaskEpoch } from "../domain/task-epoch.js";
import type { ProviderPatchOutcome } from "../provider/patch.js";
import type { ProfileObservation } from "./records.js";
import { TelemetryWriter } from "./writer.js";

export interface Usage { inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } }
interface Pending { epoch: TaskEpoch; profile: ProfileObservation; decisionId?: string; index: number; provider: string; api: string; model: string; outcome: ProviderPatchOutcome | { status: "shadow"; originalEffort?: string }; startedAt: number }
export type FlushReason = "unsettled_request" | "ambiguous_response" | "session_boundary" | "profile_boundary" | "settled_boundary";

/** Best-effort lifecycle correlation. Records retain no provider payload or conversation content. */
export class TelemetryRuntime {
  private readonly pending: Pending[] = [];
  private profileKey: string | undefined;
  constructor(readonly writer: TelemetryWriter) {}
  decision(decision: RoutingDecision, profile: ProfileObservation, mode: "shadow" | "enforce", prompt?: string): void {
    const bounded = prompt?.slice(0, 4096);
    this.writer.writeDecision({ schemaVersion: 1, policyVersion: decision.policyVersion, sessionHash: this.writer.sessionHash, epochId: decision.epochId, decisionId: decision.id, relation: decision.relation, taskClass: decision.taskClass, profile, mode, promptHash: "redacted", promptChars: prompt?.length ?? 0, ...(bounded === undefined ? {} : { promptText: bounded }), features: decision.features, reasons: decision.reasons, timestamp: decision.timestamp });
  }
  request(epoch: TaskEpoch, profile: ProfileObservation, decisionId: string | undefined, model: { provider?: unknown; api?: unknown; id?: unknown } | undefined, outcome: ProviderPatchOutcome | { status: "shadow"; originalEffort?: string }): void {
    const nextKey = JSON.stringify(profile);
    if (this.profileKey !== undefined && this.profileKey !== nextKey) this.flushUnsettled("profile_boundary");
    this.profileKey = nextKey;
    this.pending.push({ epoch, profile: decisionId === undefined ? identityObservation(profile) : profile, ...(decisionId === undefined ? {} : { decisionId }), index: epoch.requestCount, provider: typeof model?.provider === "string" ? model.provider : "unknown", api: typeof model?.api === "string" ? model.api : "unknown", model: typeof model?.id === "string" ? model.id : "unknown", outcome, startedAt: this.writer.timestamp() });
  }
  response(stopReason: string | undefined, usage?: Usage): void {
    if (this.pending.length !== 1) { this.flushUnsettled("ambiguous_response"); return; }
    const pending = this.pending.shift(); if (!pending) return;
    this.write(pending, { ...usage, ...(stopReason === undefined ? {} : { stopReason }), latencyMs: this.writer.timestamp() - pending.startedAt });
  }
  epoch(epoch: TaskEpoch, profile: ProfileObservation): void { this.writer.writeEpoch({ schemaVersion: 1, sessionHash: this.writer.sessionHash, epochId: epoch.id, status: epoch.status, taskClass: epoch.taskClass, requestCount: epoch.requestCount, toolCallCount: epoch.toolCallCount, toolErrorCount: epoch.toolErrorCount, providerErrorCount: epoch.providerErrorCount, startedAt: epoch.createdAt, endedAt: epoch.lastActivityAt, profile }); }
  flushUnsettled(error: FlushReason = "unsettled_request"): void { for (const pending of this.pending.splice(0)) this.write(pending, { correlationError: error }); }
  private write(p: Pending, extra: Record<string, unknown>): void { const o = p.outcome; this.writer.writeRequest({ schemaVersion: 1, sessionHash: this.writer.sessionHash, epochId: p.epoch.id, requestIndex: p.index, provider: p.provider, api: p.api, model: p.model, profile: p.profile, ...(p.decisionId === undefined ? { correlationError: "no_decision" } : { decisionId: p.decisionId }), ...(o.originalEffort === undefined ? {} : { originalEffort: o.originalEffort }), ...(o.status === "applied" ? { locallyAppliedProviderValue: o.appliedEffort } : {}), patchStatus: o.status, ...extra } as import("./records.js").RequestRecord); }
}

function identityObservation(profile: ProfileObservation): ProfileObservation {
  const { capability, admission, model, generation } = profile;
  return { capability, admission, model, generation };
}
