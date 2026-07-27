import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { defaultConfigPaths, loadConfig } from "./config/load.js";
import { patchProviderPayloadOutcome, type ProviderModel } from "./provider/patch.js";
import { EpochRouter, parseEffortCommand } from "./runtime/router.js";
import { TelemetryRuntime, type Usage } from "./telemetry/runtime.js";
import { TelemetryWriter } from "./telemetry/writer.js";
import { effortValues, type Effort } from "./domain/effort.js";

export type PiExtension = ExtensionFactory;
export interface ExtensionOptions { load?: () => ReturnType<typeof loadConfig>; telemetryDirectory?: string; sessionId?: string; telemetryNonce?: () => string }
const loadProductionConfig = () => loadConfig({ readFile: async (path) => { try { return await readFile(path, "utf8"); } catch { return undefined; } } }, defaultConfigPaths(homedir(), process.cwd()));

/** Pi 0.82.1 extension factory. Telemetry is best-effort and session scoped. */
export const createExtension = (options: ExtensionOptions = {}): PiExtension => async (pi: ExtensionAPI) => {
  const config = await (options.load ?? loadProductionConfig)();
  if (!config.enabled) return;
  let router: EpochRouter | undefined;
  let telemetry: TelemetryRuntime | undefined;
  let pendingDecision: ReturnType<EpochRouter["start"]> | undefined;
  let pendingTelemetry: { promptChars: number; promptHash: string; promptText?: string } | undefined;
  let lastRunFailed = false;
  const status = (ctx: ExtensionContext) => {
    if (config.ui.showStatus) ctx.ui.setStatus("pi-reap", router ? `${router.status()}${telemetry ? `\n${telemetry.writer.status()}` : ""}` : undefined);
  };
  const closeTelemetry = () => { telemetry?.flushUnsettled(); telemetry = undefined; pendingDecision = undefined; pendingTelemetry = undefined; };
  pi.registerCommand("effort", { description: "Set Pi REAP effort for this session only.", handler: async (args, ctx) => { if (router && parseEffortCommand(`/effort ${args}`, router)) status(ctx); } });
  pi.on("session_start", (event, ctx) => {
    closeTelemetry();
    router = new EpochRouter({ resumeReason: event.reason, config });
    lastRunFailed = false;
    if (config.telemetry.enabled) { const directory = options.telemetryDirectory ?? config.telemetry.directory; telemetry = new TelemetryRuntime(new TelemetryWriter({ directory: isAbsolute(directory) ? directory : resolve(ctx.cwd, directory), sessionId: `${options.sessionId ?? ctx.sessionManager.getSessionId()}:${options.telemetryNonce?.() ?? randomUUID()}` })); }
    status(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => { closeTelemetry(); router = undefined; lastRunFailed = false; if (config.ui.showStatus) ctx.ui.setStatus("pi-reap", undefined); });
  pi.on("input", (event) => router?.queueInput({ prompt: event.text, source: event.source, ...(event.streamingBehavior ? { streamingBehavior: event.streamingBehavior } : {}) }));
  pi.on("before_agent_start", (event, ctx) => { pendingTelemetry = { promptChars: event.prompt.length, promptHash: createHash("sha256").update(event.prompt).digest("hex"), ...(config.telemetry.includePromptText ? { promptText: event.prompt } : {}) }; pendingDecision = router?.startQueued(); status(ctx); });
  pi.on("before_provider_request", (event, ctx) => {
    const effort = router?.onProviderRequest(); const epoch = router?.runtime.currentEpoch;
    if (!effort || !epoch || !router) return undefined;
    const original = baselineEffort(event.payload);
    if (router.runtime.mode === "shadow") {
      if (pendingDecision && pendingTelemetry) telemetry?.decision(pendingDecision, pendingTelemetry.promptChars, "shadow", pendingDecision.selectedEffort, original, pendingTelemetry.promptHash, pendingTelemetry.promptText);
      pendingDecision = undefined; pendingTelemetry = undefined; telemetry?.request(epoch, ctx.model as ProviderModel | undefined, event.payload, "shadow", { status: "shadow", ...(original ? { originalEffort: original, appliedEffort: original } : {}) });
      return undefined;
    }
    const outcome = patchProviderPayloadOutcome(ctx.model as ProviderModel | undefined, event.payload, effort);
    if (pendingDecision && pendingTelemetry) telemetry?.decision(pendingDecision, pendingTelemetry.promptChars, "enforce", pendingDecision.selectedEffort, outcome.status === "applied" ? outcome.appliedEffort : undefined, pendingTelemetry.promptHash, pendingTelemetry.promptText);
    pendingDecision = undefined; pendingTelemetry = undefined; telemetry?.request(epoch, ctx.model as ProviderModel | undefined, event.payload, "enforce", outcome);
    return outcome.status === "applied" ? outcome.payload : undefined;
  });
  pi.on("tool_call", (event, ctx) => { router?.onToolCall(event.toolName); status(ctx); });
  pi.on("tool_execution_end", (event, ctx) => { if (event.isError) { const before = router?.effectiveEffort(); router?.onToolError(); if (config.ui.notifyOnEscalation && before !== undefined && router?.effectiveEffort() !== before) ctx.ui.notify("Pi REAP raised effort after a tool failure", "warning"); } status(ctx); });
  pi.on("message_end", (event, ctx) => { if (event.message.role === "assistant") { lastRunFailed = event.message.stopReason === "error" || event.message.stopReason === "length"; const before = router?.effectiveEffort(); telemetry?.response(event.message.stopReason, usageFrom(event.message.usage)); router?.onProviderEnd(event.message.stopReason); if (lastRunFailed && config.ui.notifyOnEscalation && before !== undefined && router?.effectiveEffort() !== before) ctx.ui.notify("Pi REAP raised effort after an assistant failure", "warning"); } status(ctx); });
  pi.on("session_compact", (event, ctx) => { router?.onCompaction(event.reason, event.willRetry); status(ctx); });
  pi.on("agent_settled", (_event, ctx) => { telemetry?.flushUnsettled(); router?.settle(lastRunFailed); lastRunFailed = false; if (router?.runtime.currentEpoch) telemetry?.epoch(router.runtime.currentEpoch); status(ctx); });
};
export const extension: PiExtension = createExtension();
export default extension;

function baselineEffort(payload: unknown): Effort | undefined { if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined; const r = (payload as Record<string, unknown>).reasoning; const value = typeof r === "object" && r !== null && !Array.isArray(r) ? (r as Record<string, unknown>).effort : undefined; return typeof value === "string" && (effortValues as readonly string[]).includes(value) ? value as Effort : undefined; }
function usageFrom(value: unknown): Usage | undefined { if (!value || typeof value !== "object" || Array.isArray(value)) return undefined; const u = value as Record<string, unknown>; const n = (...keys: string[]) => { const v = keys.map((k) => u[k]).find((x) => typeof x === "number"); return typeof v === "number" ? v : undefined; }; const inputTokens = n("inputTokens", "input"); const outputTokens = n("outputTokens", "output"); const reasoningTokens = n("reasoningTokens", "reasoning"); const cacheReadTokens = n("cacheReadTokens", "cacheRead"); const cacheWriteTokens = n("cacheWriteTokens", "cacheWrite"); return inputTokens === undefined && outputTokens === undefined && reasoningTokens === undefined && cacheReadTokens === undefined && cacheWriteTokens === undefined ? undefined : { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }), ...(reasoningTokens === undefined ? {} : { reasoningTokens }), ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }), ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }) }; }
