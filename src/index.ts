import { patchProviderPayload, type ProviderModel } from "./provider/patch.js";
import { effortValues, type Effort } from "./domain/effort.js";
import { EpochRouter, parseEffortCommand } from "./runtime/router.js";
import { TelemetryRuntime, type Usage } from "./telemetry/runtime.js";
import { TelemetryWriter } from "./telemetry/writer.js";
import type { RoutingDecision } from "./domain/routing-decision.js";

export interface PiInput { text: string; source?: string; streamingBehavior?: "steer" | "followUp" | string }
export interface PiRequest { payload: unknown }
export interface PiContext { model?: ProviderModel & { id?: unknown; provider?: unknown }; ui?: { setStatus(key: string, text: string | undefined): void } }
export type PiSessionStartReason = "resume" | "fork" | "reload" | "startup" | "new";
export interface PiLifecycleEvents {
  session_start: { reason: PiSessionStartReason };
  input: { ctx?: PiContext; text?: string; source?: string; streamingBehavior?: "steer" | "followUp"; input?: PiInput };
  before_agent_start: { ctx?: PiContext; prompt?: string };
  before_provider_request: { ctx: PiContext; request: PiRequest };
  tool_call: { ctx: PiContext; toolName: string };
  tool_execution_end: { ctx?: PiContext; isError?: boolean; error?: unknown };
  message_end: { ctx?: PiContext; stopReason?: string; message?: Record<string, unknown> };
  session_compact: { ctx: PiContext; reason: string; willRetry: boolean };
  agent_settled: { ctx?: PiContext; failed?: boolean };
}

export interface PiExtensionHost {
  registerTool(definition: unknown): void;
  setThinkingLevel(level: string): void;
  on<E extends keyof PiLifecycleEvents>(event: E, handler: (event: PiLifecycleEvents[E], context?: PiContext) => void | Partial<PiLifecycleEvents[E]> | unknown): void;
  registerCommand(name: string, options: { description?: string; handler: (input: string, context: PiContext) => void | Promise<void> }): void;
}

export type PiExtension = (pi: PiExtensionHost) => void;
export interface ExtensionOptions { telemetryDirectory?: string; sessionId?: string }

/** Registers only Pi-local commands and request-local lifecycle handlers. */
export const createExtension = (options: ExtensionOptions = {}): PiExtension => (pi) => {
  const router = new EpochRouter();
  const telemetry = new TelemetryRuntime(new TelemetryWriter({ ...(options.telemetryDirectory ? { directory: options.telemetryDirectory } : {}), ...(options.sessionId ? { sessionId: options.sessionId } : {}) }));
  let pendingDecision: { decision: RoutingDecision; promptChars: number } | undefined;
  const updateStatus = (context?: PiContext) => context?.ui?.setStatus("effort-router", `${router.status()}\n${telemetry.writer.status()}`);
  pi.registerCommand("effort", { description: "Show or change local effort routing", handler: (input, context) => { parseEffortCommand(`/effort ${input}`, router); updateStatus(context); } });
  pi.on("session_start", (event, context) => { router.setResumeReason(event.reason); updateStatus(context); });
  pi.on("input", (event) => {
    const input = event.input;
    const text = typeof event.text === "string" ? event.text : input?.text;
    const source = event.source ?? input?.source; const streamingBehavior = event.streamingBehavior ?? input?.streamingBehavior;
    if (text) router.queueInput({ prompt: text, ...(source ? { source } : {}), ...(streamingBehavior ? { streamingBehavior } : {}) });
  });
  pi.on("before_agent_start", (event, context) => {
    if (typeof event.prompt === "string") router.queueInput({ prompt: event.prompt });
    const decision = router.startQueued();
    if (decision) pendingDecision = { decision, promptChars: router.latestPromptChars() };
    updateStatus(context);
  });
  pi.on("before_provider_request", (event, context) => {
    const synthetic = "request" in event;
    const request = synthetic ? event.request : { payload: (event as { payload: unknown }).payload };
    const model = synthetic ? event.ctx.model : context?.model;
    const effort = router.onProviderRequest();
    if (effort === undefined) return undefined;
    const epoch = router.runtime.currentEpoch;
    if (!epoch) return undefined;
    if (router.runtime.mode === "shadow") {
      const applied = baselineEffort(request.payload);
      if (pendingDecision) { telemetry.decision(pendingDecision.decision, pendingDecision.promptChars, "shadow", pendingDecision.decision.selectedEffort, applied, epoch.lastPromptHash); pendingDecision = undefined; }
      telemetry.request(epoch, model, request.payload, "shadow", effort, applied, false);
      return undefined;
    }
    const payload = patchProviderPayload(model, request.payload, effort);
    if (pendingDecision) { telemetry.decision(pendingDecision.decision, pendingDecision.promptChars, "enforce", pendingDecision.decision.selectedEffort, effort, epoch.lastPromptHash); pendingDecision = undefined; }
    telemetry.request(epoch, model, request.payload, "enforce", effort, effort, payload !== request.payload);
    if (payload === request.payload) return undefined;
    return synthetic ? { request: { ...request, payload } } : payload;
  });
  pi.on("tool_call", (event, context) => { router.onToolCall(event.toolName); updateStatus(context); });
  pi.on("tool_execution_end", (event, context) => { if (event.isError === true || event.error !== undefined) router.onToolError(); updateStatus(context); });
  pi.on("message_end", (event, context) => {
    const actualMessage = event.message;
    if (actualMessage && actualMessage.role !== "assistant") return undefined;
    const usage = actualMessage ? usageFrom(actualMessage.usage) : undefined;
    const stopReason = "stopReason" in event && typeof event.stopReason === "string" ? event.stopReason : typeof actualMessage?.stopReason === "string" ? actualMessage.stopReason : undefined;
    telemetry.response(stopReason, usage); router.onProviderEnd(stopReason); updateStatus(context);
  });
  pi.on("session_compact", (event, context) => { router.onCompaction(event.reason, event.willRetry); updateStatus(context); });
  pi.on("agent_settled", (_event, context) => { router.settle(false); telemetry.flushUnsettled(); const epoch = router.runtime.currentEpoch; if (epoch) telemetry.epoch(epoch); updateStatus(context); });
};

/** The production entry point writes only redacted observation records. */
export const extension: PiExtension = createExtension();

function baselineEffort(payload: unknown): Effort | undefined {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const reasoning = (payload as Record<string, unknown>).reasoning;
    const candidate = typeof reasoning === "object" && reasoning !== null && !Array.isArray(reasoning) ? (reasoning as Record<string, unknown>).effort : undefined;
    if (typeof candidate === "string" && (effortValues as readonly string[]).includes(candidate)) return candidate as Effort;
  }
  return undefined;
}

function usageFrom(value: unknown): Usage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const number = (...keys: string[]) => { const value = keys.map((key) => usage[key]).find((item) => typeof item === "number"); return typeof value === "number" ? value : undefined; };
  const inputTokens = number("inputTokens", "input"); const outputTokens = number("outputTokens", "output"); const reasoningTokens = number("reasoningTokens", "reasoning"); const cacheReadTokens = number("cacheReadTokens", "cacheRead"); const cacheWriteTokens = number("cacheWriteTokens", "cacheWrite");
  return inputTokens === undefined && outputTokens === undefined && reasoningTokens === undefined && cacheReadTokens === undefined && cacheWriteTokens === undefined ? undefined : { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...(reasoningTokens !== undefined ? { reasoningTokens } : {}), ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}), ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}) };
}

export default extension;
