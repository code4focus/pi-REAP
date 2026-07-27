import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createProfileActivationSnapshot, type ProfileActivationSnapshot, type ProfileMatch } from "./domain/profile.js";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { defaultConfigPaths, loadConfig } from "./config/load.js";
import { safeDefaults } from "./config/defaults.js";
import { patchProviderPayloadOutcome, type ProviderPatchOutcome } from "./provider/patch.js";
import { EpochRouter, parseEffortCommand } from "./runtime/router.js";
import { TelemetryRuntime, type Usage } from "./telemetry/runtime.js";
import { TelemetryWriter } from "./telemetry/writer.js";
import type { ProfileObservation } from "./telemetry/records.js";
import { mayProductionSessionEnforce } from "./qualification/enforcement.js";

export type PiExtension = ExtensionFactory;

export interface RuntimeAttestation {
  readonly capability: unknown;
  readonly admission: unknown;
  readonly modelCatalogRevision: string;
  readonly modelCatalogDigest: string;
  readonly piVersion: string;
  readonly providerAdapterRevision: string;
  readonly providerAdapterDigest: string;
}
interface PreparedRuntimeActivation {
  readonly snapshot: ProfileActivationSnapshot;
  readonly modelCatalogRevision: string;
  readonly modelCatalogDigest: string;
  readonly piVersion: string;
  readonly providerAdapterRevision: string;
  readonly providerAdapterDigest: string;
}
export interface ExtensionOptions { load?: () => ReturnType<typeof loadConfig>; activation?: RuntimeAttestation; telemetryDirectory?: string; sessionId?: string; telemetryNonce?: () => string }
const loadProductionConfig = () => loadConfig({ readFile: async (path) => {
  try { return await readFile(path, "utf8"); } catch { return undefined; }
} }, defaultConfigPaths(homedir(), process.cwd()));

/** Pi 0.82.1 extension factory. Routing remains local to this extension session. */
export const createExtension = (options: ExtensionOptions = {}): PiExtension => async (pi: ExtensionAPI) => {
  const activation = prepareRuntimeActivation(options.activation);
  const config = await (options.load ?? loadProductionConfig)().catch(() => ({
    ...safeDefaults,
    telemetry: { ...safeDefaults.telemetry },
    ui: { ...safeDefaults.ui },
  }));
  // telemetry remains an intentionally unused, read-only PR 4 seam.
  if (!config.enabled) return;
  let router: EpochRouter | undefined;
  let telemetry: TelemetryRuntime | undefined;
  let pendingDecision: ReturnType<EpochRouter["startQueued"]> | undefined;
  let pendingPrompt: string | undefined;
  let lastRunFailed = false;
  const current = () => router;
  const status = (ctx: ExtensionContext) => {
    if (config.ui.showStatus && current()) ctx.ui.setStatus("pi-reap", `${current()!.status()}${telemetry ? `\n${telemetry.writer.status()}` : ""}`);
  };
  const revoke = (ctx: ExtensionContext): false => {
    current()?.invalidate();
    clearTelemetryBoundary("profile_boundary");
    lastRunFailed = false;
    status(ctx);
    return false;
  };
  const reconcile = (ctx: ExtensionContext, preserveQueuedInput = false): boolean => {
    const generation = current()?.generation;
    const match = runtimeMatch(ctx, activation);
    if (!match || !activation || !current()) return revoke(ctx);
    const resolved = current()!.activateSnapshot(match, activation.snapshot, { preserveQueuedInput });
    if (!resolved) return revoke(ctx);
    if (current()!.generation !== generation) { current()!.runtime.mode = "shadow"; clearTelemetryBoundary("profile_boundary"); lastRunFailed = false; }
    return resolved;
  };
  const clearTelemetryBoundary = (reason: "session_boundary" | "profile_boundary" | "settled_boundary") => {
    telemetry?.flushUnsettled(reason);
    pendingDecision = undefined;
    pendingPrompt = undefined;
  };

  pi.registerCommand("effort", {
    description: "Set Pi REAP effort for this session only.",
    handler: async (args, ctx) => {
      if (args.trim() === "enforce") {
        if (current() && mayProductionSessionEnforce(current()!.observation()?.binding)) current()!.runtime.mode = "enforce";
      } else if (current()) parseEffortCommand(`/effort ${args}`, current()!);
      status(ctx);
    },
  });
  pi.on("session_start", (event, ctx) => {
    // A start always replaces all state, including an explicit max override.
    clearTelemetryBoundary("session_boundary"); telemetry = undefined;
    // Settings never authorize a provider patch; each session begins in shadow.
    router = new EpochRouter({ resumeReason: event.reason, config: { ...config, mode: "shadow" } });
    reconcile(ctx);
    lastRunFailed = false;
    if (config.telemetry.enabled) { const directory = options.telemetryDirectory ?? config.telemetry.directory; telemetry = new TelemetryRuntime(new TelemetryWriter({ directory: isAbsolute(directory) ? directory : resolve(ctx.cwd, directory), sessionId: `${options.sessionId ?? ctx.sessionManager.getSessionId()}:${options.telemetryNonce?.() ?? randomUUID()}` })); }
    status(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    clearTelemetryBoundary("session_boundary"); telemetry = undefined;
    router = undefined;
    lastRunFailed = false;
    if (config.ui.showStatus) ctx.ui.setStatus("pi-reap", undefined);
  });
  pi.on("input", (event) => { current()?.queueInput({ prompt: event.text, source: event.source, ...(event.streamingBehavior ? { streamingBehavior: event.streamingBehavior } : {}) }); });
  pi.on("before_agent_start", (event, ctx) => {
    if (reconcile(ctx, true)) {
      if (current()?.replaceQueuedPrompt(event.prompt)) { pendingDecision = current()?.startQueued(); pendingPrompt = config.telemetry.includePromptText ? event.prompt : undefined; }
    }
    status(ctx);
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (!reconcile(ctx)) return undefined;
    // Qualification is time- and evidence-bound. Revalidate immediately before
    // every provider patch; an expired or no-longer-exact qualification revokes
    // the session-local opt-in before the payload is inspected.
    if (current()?.runtime.mode === "enforce"
      && !mayProductionSessionEnforce(current()?.observation()?.binding)) {
      current()!.runtime.mode = "shadow";
    }
    const resolved = current()?.onProviderRequest();
    const input = current()?.providerInput();
    const epoch = current()?.runtime.currentEpoch;
    const observation = observationFor(current());
    if (!input || !epoch || !observation || !resolved) { status(ctx); return undefined; }
    if (pendingDecision) telemetry?.decision(pendingDecision, observation, current()!.runtime.mode, pendingPrompt);
    const decisionId = pendingDecision?.id;
    pendingDecision = undefined; pendingPrompt = undefined;
    if (current()?.runtime.mode === "shadow") { const originalEffort = baselineEffort(event.payload, current()); telemetry?.request(epoch, observation, decisionId, ctx.model, originalEffort === undefined ? { status: "shadow" } : { status: "shadow", originalEffort }); status(ctx); return undefined; }
    const outcome = patchProviderPayloadOutcome(input, event.payload);
    telemetry?.request(epoch, observation, decisionId, ctx.model, safeTelemetryOutcome(outcome, current()));
    status(ctx);
    return outcome.status === "applied" ? outcome.payload : undefined;
  });
  pi.on("tool_call", (event, ctx) => { current()?.onToolCall(event.toolName); status(ctx); });
  pi.on("tool_execution_end", (event, ctx) => { if (event.isError) { const before = current()?.effectiveRung()?.ordinal; current()?.onToolError(); if (config.ui.notifyOnEscalation && before !== undefined && current()?.effectiveRung()?.ordinal !== before) ctx.ui.notify("Pi REAP raised effort after a tool failure", "warning"); } status(ctx); });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant") {
      const failed = event.message.stopReason === "error" || event.message.stopReason === "length";
      lastRunFailed = failed;
      telemetry?.response(event.message.stopReason, usageFrom(event.message.usage));
      const before = current()?.effectiveRung()?.ordinal; current()?.onProviderEnd(event.message.stopReason);
      if (failed && config.ui.notifyOnEscalation && before !== undefined && current()?.effectiveRung()?.ordinal !== before) ctx.ui.notify("Pi REAP raised effort after an assistant failure", "warning");
    }
    status(ctx);
  });
  pi.on("session_compact", (event, ctx) => { current()?.onCompaction(event.reason, event.willRetry); status(ctx); });
  // Pi 0.82.1 agent_settled is fieldless; settle only the recorded terminal result.
  pi.on("agent_settled", (_event, ctx) => { clearTelemetryBoundary("settled_boundary"); current()?.settle(lastRunFailed); const epoch = current()?.runtime.currentEpoch; const observation = observationFor(current()); if (epoch && observation) telemetry?.epoch(epoch, observation); lastRunFailed = false; status(ctx); });
};

export const extension: PiExtension = createExtension();

export default extension;

function prepareRuntimeActivation(value: unknown): PreparedRuntimeActivation | undefined {
  const record = ownDataRecord(value, [
    "capability", "admission", "modelCatalogRevision", "modelCatalogDigest", "piVersion", "providerAdapterRevision", "providerAdapterDigest",
  ]);
  if (!record
    || typeof record.modelCatalogRevision !== "string" || typeof record.modelCatalogDigest !== "string"
    || typeof record.piVersion !== "string" || typeof record.providerAdapterRevision !== "string" || typeof record.providerAdapterDigest !== "string") return undefined;
  const snapshot = createProfileActivationSnapshot(record.capability, record.admission);
  return Object.freeze({
    snapshot,
    modelCatalogRevision: record.modelCatalogRevision,
    modelCatalogDigest: record.modelCatalogDigest,
    piVersion: record.piVersion,
    providerAdapterRevision: record.providerAdapterRevision,
    providerAdapterDigest: record.providerAdapterDigest,
  });
}

function runtimeMatch(ctx: ExtensionContext, activation: PreparedRuntimeActivation | undefined): ProfileMatch | undefined {
  if (!activation) return undefined;
  try {
    const model = ctx.model;
    const record = ownDataRecord(model, ["provider", "api", "id"], false);
    if (!record || typeof record.provider !== "string" || typeof record.api !== "string" || typeof record.id !== "string") return undefined;
    return Object.freeze({
      provider: record.provider,
      api: record.api,
      model: record.id,
      modelCatalogRevision: activation.modelCatalogRevision,
      modelCatalogDigest: activation.modelCatalogDigest,
      piVersion: activation.piVersion,
      providerAdapterRevision: activation.providerAdapterRevision,
      providerAdapterDigest: activation.providerAdapterDigest,
    });
  } catch { return undefined; }
}

/** Reads own data descriptors only: hostile getters and proxies fail closed without execution. */
function ownDataRecord(value: unknown, keys: readonly string[], exact = true): Record<string, unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string") || keys.some((key) => !ownKeys.includes(key)) || (exact && ownKeys.length !== keys.length)) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) return undefined;
      result[key] = descriptor.value;
    }
    return result;
  } catch { return undefined; }
}

function baselineEffort(payload: unknown, router: EpochRouter | undefined): string | undefined { if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined; const reasoning = (payload as Record<string, unknown>).reasoning; const effort = typeof reasoning === "object" && reasoning !== null && !Array.isArray(reasoning) && typeof (reasoning as Record<string, unknown>).effort === "string" ? (reasoning as Record<string, string>).effort : undefined; return effort !== undefined && router?.isKnownProviderEffort(effort) ? effort : undefined; }
function safeTelemetryOutcome(outcome: ProviderPatchOutcome, router: EpochRouter | undefined): ProviderPatchOutcome { if (outcome.originalEffort === undefined || router?.isKnownProviderEffort(outcome.originalEffort)) return outcome; const { originalEffort: _redacted, ...safe } = outcome; return safe as ProviderPatchOutcome; }
function usageFrom(value: unknown): Usage | undefined { if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined; const source = value as Record<string, unknown>; const number = (key: string): number | undefined => typeof source[key] === "number" && Number.isFinite(source[key]) ? source[key] : undefined; const usage: Usage = {}; const fields: readonly [string, "inputTokens" | "outputTokens" | "reasoningTokens" | "cacheReadTokens" | "cacheWriteTokens"][] = [["input", "inputTokens"], ["output", "outputTokens"], ["reasoning", "reasoningTokens"], ["cacheRead", "cacheReadTokens"], ["cacheWrite", "cacheWriteTokens"]]; for (const [from, to] of fields) { const measured = number(from); if (measured !== undefined) usage[to] = measured; } const cost = source.cost; if (typeof cost === "object" && cost !== null && !Array.isArray(cost)) { const costRecord = cost as Record<string, unknown>; const values = ["input", "output", "cacheRead", "cacheWrite", "total"] as const; if (values.every((key) => typeof costRecord[key] === "number" && Number.isFinite(costRecord[key]))) usage.cost = { input: costRecord.input as number, output: costRecord.output as number, cacheRead: costRecord.cacheRead as number, cacheWrite: costRecord.cacheWrite as number, total: costRecord.total as number }; } return Object.keys(usage).length ? usage : undefined; }
function observationFor(router: EpochRouter | undefined): ProfileObservation | undefined { if (!router) return undefined; const o = router.observation(); if (!o) return undefined; const rung = (v: { rungId: string; ordinal: number } | undefined) => v === undefined ? undefined : { rungId: v.rungId, ordinal: v.ordinal }; const b = o.binding; const provider = router.providerInput()?.boundSelection; const value = provider && typeof provider === "object" && typeof (provider as { effort?: unknown }).effort === "string" ? (provider as { effort: string }).effort : undefined; const selected = rung(o.selected); const effective = rung(o.effective); const manual = rung(o.manual); return { capability: { id: b.capability.profileId, revision: b.capability.profileRevision, digest: b.capability.profileDigest, source: o.capabilitySource }, admission: { id: b.admission.profileId, revision: b.admission.profileRevision, digest: b.admission.profileDigest, source: o.admissionSource }, model: { provider: b.match.provider, api: b.match.api, model: b.match.model, catalogRevision: b.match.modelCatalogRevision, catalogDigest: b.match.modelCatalogDigest, piVersion: b.match.piVersion, adapterRevision: b.match.providerAdapterRevision, adapterDigest: b.match.providerAdapterDigest }, ...(o.selector === undefined ? {} : { selector: o.selector }), ...(selected === undefined ? {} : { requested: selected }), ...(effective === undefined ? {} : { effective }), ...(manual === undefined ? {} : { manual }), ...(o.escalation === undefined ? {} : { escalation: { selector: o.escalation.selector, rungId: o.escalation.rung.rungId, ordinal: o.escalation.rung.ordinal } }), ...(effective === undefined || value === undefined ? {} : { resolved: { ...effective, providerValue: value } }), generation: router.generation }; }
