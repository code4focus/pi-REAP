import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRungSelector } from "../../src/domain/profile.js";
import type { ProfileObservation } from "../../src/telemetry/records.js";
import type { ObservedProduction, ObservedRequest, ObservedRequestKey, ObservedRouting, ProductionObservation, UnavailableProduction, UsageMetrics } from "./types.js";

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const requiredString = (record: Json, key: string): string => { const value = string(record[key]); if (value === undefined || value.length === 0) throw new Error(`malformed telemetry: ${key}`); return value; };
const requiredNumber = (record: Json, key: string): number => { const value = number(record[key]); if (value === undefined) throw new Error(`malformed telemetry: ${key}`); return value; };
const requiredNonnegativeInteger = (record: Json, key: string): number => { const value = requiredNumber(record, key); if (!Number.isInteger(value) || value < 0) throw new Error(`malformed telemetry: ${key}`); return value; };
const optionalString = (record: Json, key: string): string | undefined => Object.hasOwn(record, key) ? requiredString(record, key) : undefined;
const optionalNonnegativeInteger = (record: Json, key: string): number | undefined => Object.hasOwn(record, key) ? requiredNonnegativeInteger(record, key) : undefined;
const requiredNonnegativeNumber = (record: Json, key: string): number => { const value = requiredNumber(record, key); if (value < 0) throw new Error(`malformed telemetry: ${key}`); return value; };

interface Decision { readonly sessionHash: string; readonly epochId: string; readonly decisionId: string; readonly profile: ProfileObservation; }
interface Request { readonly key: ObservedRequestKey; readonly decisionId?: string; readonly profile: ProfileObservation; readonly patchStatus: ObservedRequest["patchStatus"]; readonly locallyAppliedProviderValue?: string; readonly originalEffort?: string; readonly provider: string; readonly api: string; readonly model: string; readonly usage: UsageMetrics; readonly telemetryLifecycleLatencyMs?: number; readonly correlationError?: string; }
interface Epoch { readonly sessionHash: string; readonly epochId: string; readonly status: string; readonly requestCount: number; readonly profile: ProfileObservation; }

export const observedRequestKeyIdentity = (key: ObservedRequestKey): string => JSON.stringify([key.sessionHash, key.epochId, key.requestIndex]);

function profile(value: unknown): ProfileObservation {
  if (!isRecord(value)) throw new Error("malformed telemetry: profile");
  const capability = isRecord(value.capability) ? value.capability : undefined; const admission = isRecord(value.admission) ? value.admission : undefined; const model = isRecord(value.model) ? value.model : undefined;
  if (!capability || !admission || !model) throw new Error("malformed telemetry: profile identity");
  for (const [record, keys] of [[capability, ["id", "revision", "digest"]], [admission, ["id", "revision", "digest"]], [model, ["provider", "api", "model", "catalogRevision", "catalogDigest", "piVersion", "adapterRevision", "adapterDigest"]]] as const) for (const key of keys) requiredString(record, key);
  if (!isRecord(capability.source) || !isRecord(admission.source)) throw new Error("malformed telemetry: profile source");
  const rung = (v: unknown, providerValue = false) => { if (v === undefined) return undefined; if (!isRecord(v)) throw new Error("malformed telemetry: rung"); const result = { rungId: requiredString(v, "rungId"), ordinal: requiredNonnegativeInteger(v, "ordinal"), ...(providerValue && Object.hasOwn(v, "providerValue") ? { providerValue: requiredString(v, "providerValue") } : {}) }; return result; };
  const selector = (v: unknown) => {
    if (v === undefined) return undefined;
    const parsed = parseRungSelector(v);
    if (!parsed) throw new Error("malformed telemetry: selector");
    return parsed;
  };
  const escalation = value.escalation === undefined ? undefined : isRecord(value.escalation) ? { selector: selector(value.escalation.selector)!, rungId: requiredString(value.escalation, "rungId"), ordinal: requiredNonnegativeInteger(value.escalation, "ordinal") } : undefined;
  if (value.escalation !== undefined && !escalation) throw new Error("malformed telemetry: escalation");
  return { capability: { id: requiredString(capability, "id"), revision: requiredString(capability, "revision"), digest: requiredString(capability, "digest"), source: capability.source }, admission: { id: requiredString(admission, "id"), revision: requiredString(admission, "revision"), digest: requiredString(admission, "digest"), source: admission.source }, model: { provider: requiredString(model, "provider"), api: requiredString(model, "api"), model: requiredString(model, "model"), catalogRevision: requiredString(model, "catalogRevision"), catalogDigest: requiredString(model, "catalogDigest"), piVersion: requiredString(model, "piVersion"), adapterRevision: requiredString(model, "adapterRevision"), adapterDigest: requiredString(model, "adapterDigest") }, ...(selector(value.selector) ? { selector: selector(value.selector)! } : {}), ...(rung(value.resolved, true) ? { resolved: rung(value.resolved, true)! } : {}), ...(rung(value.requested) ? { requested: rung(value.requested)! } : {}), ...(rung(value.effective) ? { effective: rung(value.effective)! } : {}), ...(rung(value.manual) ? { manual: rung(value.manual)! } : {}), ...(escalation ? { escalation } : {}), generation: requiredNonnegativeInteger(value, "generation") };
}
function lines(directory: string, name: string): Json[] { try { const text = readFileSync(join(directory, name), "utf8").trim(); return text ? text.split("\n").map((line) => { try { const parsed: unknown = JSON.parse(line); if (!isRecord(parsed)) throw new Error("not object"); return parsed; } catch { throw new Error("malformed telemetry jsonl"); } }) : []; } catch (error) { if (isRecord(error) && (error as { code?: unknown }).code === "ENOENT") return []; throw error; } }
function decision(value: Json): Decision { if (value.schemaVersion !== 1) throw new Error("malformed telemetry schema"); return { sessionHash: requiredString(value, "sessionHash"), epochId: requiredString(value, "epochId"), decisionId: requiredString(value, "decisionId"), profile: profile(value.profile) }; }
function request(value: Json): Request {
  if (value.schemaVersion !== 1) throw new Error("malformed telemetry schema");
  const patchStatus = string(value.patchStatus);
  if (patchStatus !== "shadow" && patchStatus !== "applied" && patchStatus !== "unsupported" && patchStatus !== "invalid_payload" && patchStatus !== "mapping_failed") throw new Error("malformed telemetry patch status");
  const cost = value.cost === undefined ? undefined : isRecord(value.cost) ? { input: requiredNonnegativeNumber(value.cost, "input"), output: requiredNonnegativeNumber(value.cost, "output"), cacheRead: requiredNonnegativeNumber(value.cost, "cacheRead"), cacheWrite: requiredNonnegativeNumber(value.cost, "cacheWrite"), total: requiredNonnegativeNumber(value.cost, "total") } : (() => { throw new Error("malformed telemetry: cost"); })();
  const correlationError = optionalString(value, "correlationError");
  if (correlationError !== undefined && !["missing_pending_request", "unsettled_request", "concurrent_pending_request", "ambiguous_response", "no_decision", "session_boundary", "profile_boundary", "settled_boundary"].includes(correlationError)) throw new Error("malformed telemetry: correlationError");
  const optionalMetric = (key: string) => optionalNonnegativeInteger(value, key);
  const decisionId = optionalString(value, "decisionId"); const locallyAppliedProviderValue = optionalString(value, "locallyAppliedProviderValue"); const originalEffort = optionalString(value, "originalEffort"); const telemetryLifecycleLatencyMs = optionalNonnegativeInteger(value, "latencyMs");
  if ((patchStatus === "applied") !== (locallyAppliedProviderValue !== undefined)) throw new Error("malformed telemetry: locallyAppliedProviderValue");
  return {
    key: { sessionHash: requiredString(value, "sessionHash"), epochId: requiredString(value, "epochId"), requestIndex: requiredNonnegativeInteger(value, "requestIndex") },
    ...(decisionId === undefined ? {} : { decisionId }),
    profile: profile(value.profile), patchStatus,
    ...(locallyAppliedProviderValue === undefined ? {} : { locallyAppliedProviderValue }),
    ...(originalEffort === undefined ? {} : { originalEffort }),
    provider: requiredString(value, "provider"), api: requiredString(value, "api"), model: requiredString(value, "model"),
    usage: { ...(optionalMetric("inputTokens") === undefined ? {} : { inputTokens: optionalMetric("inputTokens")! }), ...(optionalMetric("outputTokens") === undefined ? {} : { outputTokens: optionalMetric("outputTokens")! }), ...(optionalMetric("reasoningTokens") === undefined ? {} : { reasoningTokens: optionalMetric("reasoningTokens")! }), ...(optionalMetric("cacheReadTokens") === undefined ? {} : { cacheReadTokens: optionalMetric("cacheReadTokens")! }), ...(optionalMetric("cacheWriteTokens") === undefined ? {} : { cacheWriteTokens: optionalMetric("cacheWriteTokens")! }), ...(cost ? { cost } : {}) },
    ...(telemetryLifecycleLatencyMs === undefined ? {} : { telemetryLifecycleLatencyMs }),
    ...(correlationError === undefined ? {} : { correlationError }),
  };
}
function epoch(value: Json): Epoch { if (value.schemaVersion !== 1) throw new Error("malformed telemetry schema"); return { sessionHash: requiredString(value, "sessionHash"), epochId: requiredString(value, "epochId"), status: requiredString(value, "status"), requestCount: requiredNonnegativeInteger(value, "requestCount"), profile: profile(value.profile) }; }
const same = (a: ProfileObservation, b: ProfileObservation) => a.capability.id === b.capability.id && a.capability.revision === b.capability.revision && a.capability.digest === b.capability.digest && JSON.stringify(a.capability.source) === JSON.stringify(b.capability.source) && a.admission.id === b.admission.id && a.admission.revision === b.admission.revision && a.admission.digest === b.admission.digest && JSON.stringify(a.admission.source) === JSON.stringify(b.admission.source) && JSON.stringify(a.model) === JSON.stringify(b.model);
const sameRung = (a: { rungId: string; ordinal: number }, b: { rungId: string; ordinal: number } | undefined): boolean => b !== undefined && a.rungId === b.rungId && a.ordinal === b.ordinal;
const withProviderValue = (rung: { rungId: string; ordinal: number }, resolved: ProfileObservation["resolved"]) => ({ ...rung, ...(sameRung(rung, resolved) && resolved?.providerValue !== undefined ? { providerValue: resolved.providerValue } : {}) });
function routing(p: ProfileObservation): ObservedRouting {
  return { ...(p.selector ? { selector: p.selector } : {}), ...(p.requested ? { selected: withProviderValue(p.requested, p.resolved) } : {}), ...(p.effective ? { effective: withProviderValue(p.effective, p.resolved) } : {}), ...(p.manual ? { manual: withProviderValue(p.manual, p.resolved) } : {}), ...(p.escalation ? { escalation: { selector: p.escalation.selector, rung: withProviderValue({ rungId: p.escalation.rungId, ordinal: p.escalation.ordinal }, p.resolved) } } : {}), ...(p.resolved?.providerValue ? { providerValue: p.resolved.providerValue } : {}) };
}
function observedRequest(r: Request): ObservedRequest {
  return { key: r.key, patchStatus: r.patchStatus, ...(r.locallyAppliedProviderValue === undefined ? {} : { locallyAppliedProviderValue: r.locallyAppliedProviderValue }), ...(r.originalEffort === undefined ? {} : { originalEffort: r.originalEffort }), ...(r.decisionId === undefined ? {} : { decisionId: r.decisionId }), provider: r.provider, api: r.api, model: r.model, usage: r.usage, ...(r.telemetryLifecycleLatencyMs === undefined ? {} : { telemetryLifecycleLatencyMs: r.telemetryLifecycleLatencyMs }) };
}
function hookMatches(r: Request, hookPayload: unknown): boolean {
  const hookEffort = isRecord(hookPayload) && isRecord(hookPayload.reasoning) ? string(hookPayload.reasoning.effort) : undefined;
  return r.patchStatus === "applied" ? hookEffort !== undefined && hookEffort === r.locallyAppliedProviderValue : hookPayload === undefined;
}
function correlated(decisions: readonly Decision[], epochs: readonly Epoch[], r: Request): { decision: Decision; epoch: Epoch } | undefined {
  if (r.correlationError !== undefined || r.decisionId === undefined) return undefined;
  const matchesDecision = decisions.filter((d) => d.sessionHash === r.key.sessionHash && d.epochId === r.key.epochId && d.decisionId === r.decisionId);
  const matchesEpoch = epochs.filter((e) => e.sessionHash === r.key.sessionHash && e.epochId === r.key.epochId);
  if (matchesDecision.length !== 1 || matchesEpoch.length !== 1) return undefined;
  const d = matchesDecision[0]!; const e = matchesEpoch[0]!;
  if (r.key.requestIndex < 1 || r.key.requestIndex > e.requestCount || r.provider !== d.profile.model.provider || r.api !== d.profile.model.api || r.model !== d.profile.model.model || !same(d.profile, r.profile) || !same(d.profile, e.profile)) return undefined;
  return { decision: d, epoch: e };
}
function production(r: Request, e: Epoch, output?: string): ObservedProduction {
  return { kind: "observed", profile: r.profile, routing: routing(r.profile), request: observedRequest(r), epoch: { id: e.epochId, status: e.status, requestCount: e.requestCount }, ...(output === undefined ? {} : { output: { value: output, provenance: "synthetic-provider-lifecycle" } }) };
}
export function observeTelemetry(directory: string, hookPayload: unknown, output?: string): ProductionObservation {
  try {
    const decisions = lines(directory, "decisions.jsonl").map(decision); const requests = lines(directory, "requests.jsonl").map(request); const epochs = lines(directory, "epochs.jsonl").map(epoch);
    if (decisions.length === 0 && requests.length === 0 && epochs.length === 0) return { kind: "unavailable", reason: "no-telemetry" };
    if (new Set(requests.map((value) => observedRequestKeyIdentity(value.key))).size !== requests.length) return { kind: "unavailable", reason: "ambiguous-telemetry" };
    if (decisions.length !== 1 || requests.length !== 1 || epochs.length !== 1) return { kind: "unavailable", reason: "ambiguous-telemetry" };
    const [d] = decisions; const [r] = requests; const [e] = epochs;
    if (!d || !r || !e || !correlated(decisions, epochs, r) || e.requestCount !== r.key.requestIndex || !hookMatches(r, hookPayload)) return { kind: "unavailable", reason: "ambiguous-telemetry" };
    return production(r, e, output);
  } catch { return { kind: "unavailable", reason: "malformed-telemetry" }; }
}

export type TelemetrySequenceObservation = { readonly kind: "observed-sequence"; readonly before: ObservedProduction; readonly after: ObservedProduction } | UnavailableProduction;
/** Strictly correlates a two-request evidence lifecycle without deriving or guessing an identity. */
export function observeTelemetrySequence(directory: string, hookPayloads: readonly unknown[], output?: string): TelemetrySequenceObservation {
  try {
    const decisions = lines(directory, "decisions.jsonl").map(decision); const requests = lines(directory, "requests.jsonl").map(request); const epochs = lines(directory, "epochs.jsonl").map(epoch);
    if (requests.length !== 2 || hookPayloads.length !== 2 || decisions.length < 1 || decisions.length > 2 || epochs.length < 1 || epochs.length > 2) return { kind: "unavailable", reason: "ambiguous-telemetry" };
    if (new Set(requests.map((value) => observedRequestKeyIdentity(value.key))).size !== requests.length) return { kind: "unavailable", reason: "ambiguous-telemetry" };
    const links = requests.map((value) => correlated(decisions, epochs, value));
    if (links.some((value) => value === undefined) || !requests.every((value, index) => hookMatches(value, hookPayloads[index]))) return { kind: "unavailable", reason: "ambiguous-telemetry" };
    for (const epochValue of epochs) {
      const epochRequests = requests.filter((value) => value.key.sessionHash === epochValue.sessionHash && value.key.epochId === epochValue.epochId);
      if (epochRequests.length === 0 || Math.max(...epochRequests.map((value) => value.key.requestIndex)) !== epochValue.requestCount) return { kind: "unavailable", reason: "ambiguous-telemetry" };
    }
    return { kind: "observed-sequence", before: production(requests[0]!, links[0]!.epoch), after: production(requests[1]!, links[1]!.epoch, output) };
  } catch { return { kind: "unavailable", reason: "malformed-telemetry" }; }
}
