import { patchProviderPayload, type ProviderModel } from "./provider/patch.js";
import { EpochRouter, parseEffortCommand } from "./runtime/router.js";

export interface PiInput { text: string; source?: string; streamingBehavior?: "steer" | "followUp" | string }
export interface PiRequest { payload: unknown }
export interface PiContext { model: ProviderModel }
export type PiSessionStartReason = "resume" | "fork" | "reload" | "startup" | "new";
export interface PiLifecycleEvents {
  session_start: { reason: PiSessionStartReason };
  input: { ctx: PiContext; input: PiInput };
  before_agent_start: { ctx: PiContext };
  before_provider_request: { ctx: PiContext; request: PiRequest };
  tool_call: { ctx: PiContext; toolName: string };
  tool_execution_end: { ctx: PiContext; error?: unknown };
  message_end: { ctx: PiContext; stopReason?: string };
  session_compact: { ctx: PiContext; reason: string; willRetry: boolean };
  agent_settled: { ctx: PiContext; failed?: boolean };
}

export interface PiExtensionHost {
  registerTool(definition: unknown): void;
  setThinkingLevel(level: string): void;
  on<E extends keyof PiLifecycleEvents>(event: E, handler: (event: PiLifecycleEvents[E]) => void | Partial<PiLifecycleEvents[E]>): void;
  registerCommand?(command: { name: string; handler: (input: string) => unknown }): void;
  setStatus?(status: string): void;
}

export type PiExtension = (pi: PiExtensionHost) => void;

/** Registers only Pi-local commands and request-local lifecycle handlers. */
export const extension: PiExtension = (pi) => {
  const router = new EpochRouter();
  const updateStatus = () => pi.setStatus?.(router.status());
  pi.registerCommand?.({ name: "effort", handler: (input) => { const handled = parseEffortCommand(`/effort ${input}`, router); updateStatus(); return handled; } });
  pi.on("session_start", (event) => { router.setResumeReason(event.reason); updateStatus(); });
  pi.on("input", (event) => {
    router.queueInput({ prompt: event.input.text, ...(event.input.source ? { source: event.input.source } : {}), ...(event.input.streamingBehavior ? { streamingBehavior: event.input.streamingBehavior } : {}) });
  });
  pi.on("before_agent_start", () => {
    router.startQueued();
    updateStatus();
  });
  pi.on("before_provider_request", (event) => {
    const effort = router.onProviderRequest();
    if (effort === undefined) return undefined;
    const payload = patchProviderPayload(event.ctx.model, event.request.payload, effort);
    return payload === event.request.payload ? undefined : { request: { ...event.request, payload } };
  });
  pi.on("tool_call", (event) => { router.onToolCall(event.toolName); updateStatus(); });
  pi.on("tool_execution_end", (event) => { if (event.error !== undefined) router.onToolError(); updateStatus(); });
  pi.on("message_end", (event) => { router.onProviderEnd(event.stopReason); updateStatus(); });
  pi.on("session_compact", (event) => { router.onCompaction(event.reason, event.willRetry); updateStatus(); });
  pi.on("agent_settled", (event) => { router.settle(event.failed === true); updateStatus(); });
};

export default extension;
