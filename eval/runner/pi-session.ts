import type { AgentSettledEvent, BeforeAgentStartEvent, BeforeProviderRequestEvent, BuildSystemPromptOptions, ExtensionAPI, ExtensionContext, InputEvent, MessageEndEvent, SessionCompactEvent, SessionShutdownEvent, SessionStartEvent, ToolCallEvent, ToolExecutionEndEvent } from "@earendil-works/pi-coding-agent";
import { createExtension, type ExtensionOptions } from "../../src/index.js";
import { patchProviderPayloadOutcome, type ProviderModel } from "../../src/provider/patch.js";
import type { AutomaticEffort } from "../../src/domain/effort.js";
import type { CorpusTask } from "../corpus/types.js";
import type { EvaluationExecutor, ExecutionRequest, ExecutionResult, UsageMetrics } from "./types.js";

type Events = { session_start: SessionStartEvent; session_shutdown: SessionShutdownEvent; input: InputEvent; before_agent_start: BeforeAgentStartEvent; before_provider_request: BeforeProviderRequestEvent; tool_call: ToolCallEvent; tool_execution_end: ToolExecutionEndEvent; message_end: MessageEndEvent; session_compact: SessionCompactEvent; agent_settled: AgentSettledEvent };
type Handler<E extends keyof Events> = (event: Events[E], context: ExtensionContext) => unknown;
export type ReplacementReason = "new" | "resume" | "fork" | "reload";
type HarnessContext = Pick<ExtensionContext, "cwd"> & { readonly model: Pick<NonNullable<ExtensionContext["model"]>, "id" | "provider" | "api" | "reasoning">; readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">; readonly ui: Pick<ExtensionContext["ui"], "setStatus" | "notify"> };
type HarnessContextContract = HarnessContext extends Pick<ExtensionContext, "cwd"> & { readonly model: Pick<NonNullable<ExtensionContext["model"]>, "id" | "provider" | "api" | "reasoning">; readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">; readonly ui: Pick<ExtensionContext["ui"], "setStatus" | "notify"> } ? true : false;
const _harnessContextContract: HarnessContextContract = true;
const systemPromptOptions: BuildSystemPromptOptions = { cwd: process.cwd() };
const defaultControlModel: ProviderModel = { api: "openai-responses", reasoning: true };

/** Synthetic, source-safe Pi 0.82.1 host used to drive the production extension in evaluation. */
class InMemoryPiSession {
  sessionId = "evaluation-session-1";
  readonly commands = new Map<string, { handler: (args: string, context: ExtensionContext) => Promise<void> }>();
  private readonly handlers: { [E in keyof Events]: Handler<E>[] } = { session_start: [], session_shutdown: [], input: [], before_agent_start: [], before_provider_request: [], tool_call: [], tool_execution_end: [], message_end: [], session_compact: [], agent_settled: [] };
  private readonly context: HarnessContext = { cwd: process.cwd(), model: { id: "synthetic-evaluation", provider: "openai", api: "openai-responses", reasoning: true }, sessionManager: { getSessionId: () => this.sessionId }, ui: { setStatus: () => undefined, notify: () => undefined } };
  /** Handler boundary: production handlers receive the Pi context, while this source-safe host implements only the Pick-derived fields it exercises. */
  private get lifecycleContext(): HarnessContext & ExtensionContext { return this.context as HarnessContext & ExtensionContext; }
  on<E extends keyof Events>(event: E, handler: Handler<E>): void { this.handlers[event].push(handler); }
  registerCommand(name: string, options: { handler: (args: string, context: ExtensionContext) => Promise<void> }): void { this.commands.set(name, options); }
  emit<E extends keyof Events>(event: E, value: Events[E]): unknown { let response: unknown; for (const handler of this.handlers[event]) { const next = handler(value, this.lifecycleContext); if (next !== undefined) response = next; } return response; }
  start(reason: SessionStartEvent["reason"] = "startup"): void { this.emit("session_start", { type: "session_start", reason } satisfies SessionStartEvent); }
  shutdown(reason: SessionShutdownEvent["reason"] = "new"): void { this.emit("session_shutdown", { type: "session_shutdown", reason } satisfies SessionShutdownEvent); }
  async setEffort(effort: "auto" | AutomaticEffort | "max"): Promise<void> { await this.commands.get("effort")?.handler(effort, this.lifecycleContext); }
  run(prompt: string): unknown { this.emit("input", { type: "input", text: prompt, source: "interactive" } satisfies InputEvent); this.emit("before_agent_start", { type: "before_agent_start", prompt, systemPrompt: "", systemPromptOptions } satisfies BeforeAgentStartEvent); return this.emit("before_provider_request", { type: "before_provider_request", payload: { reasoning: {} } } satisfies BeforeProviderRequestEvent); }
  failTool(): void { this.emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "synthetic", toolName: "read", result: {}, isError: true } satisfies ToolExecutionEndEvent); }
  finish(stopReason: "error" | "length" | "aborted" | "stop" = "stop"): void { const message = { role: "assistant" as const, content: [], api: "openai-responses", provider: "openai", model: "synthetic-evaluation", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: 0 } satisfies Extract<MessageEndEvent["message"], { role: "assistant" }>; this.emit("message_end", { type: "message_end", message } satisfies MessageEndEvent); this.emit("agent_settled", { type: "agent_settled" } satisfies AgentSettledEvent); }
  /** Registration boundary: the production extension uses only `on` and `registerCommand`; this isolates its Pick-derived partial host. */
  asExtensionApi(): ExtensionAPI { return { on: this.on.bind(this), registerCommand: this.registerCommand.bind(this) } as ExtensionAPI; }
}

const selectedEffort = (payload: unknown): AutomaticEffort => {
  const effort = (payload as { reasoning?: { effort?: unknown } } | undefined)?.reasoning?.effort;
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh") return effort;
  throw new Error("production extension did not apply a supported reasoning.effort");
};

const syntheticUsage: UsageMetrics = { inputTokens: 20, uncachedInputTokens: 10, outputTokens: 2, reasoningTokens: 3, cacheReadTokens: 10, cacheWriteTokens: 1 };

/** Uses production provider-adapter controls and reuses one production extension session for policy runs and session switches. */
export class PiSessionExecutor implements EvaluationExecutor {
  private readonly session = new InMemoryPiSession();
  private readonly controlModel: ProviderModel;
  private sessionNumber = 1;
  /** Evaluation audit counters: controlled adapter patches and policy provider hooks are distinct. */
  controlledAdapterCalls = 0;
  policyProviderHookCalls = 0;
  private constructor(controlModel: ProviderModel) { this.controlModel = controlModel; }
  static async create(options: ExtensionOptions, controlModel: ProviderModel = defaultControlModel): Promise<PiSessionExecutor> { const executor = new PiSessionExecutor(controlModel); await createExtension(options)(executor.session.asExtensionApi()); executor.session.start(); return executor; }
  async switchSession(reason: ReplacementReason = "new"): Promise<void> { this.session.shutdown(reason); this.sessionNumber += 1; this.session.sessionId = `evaluation-session-${this.sessionNumber}`; this.session.start(reason); }
  async setLocalEffort(effort: "auto" | AutomaticEffort | "max"): Promise<void> { await this.session.setEffort(effort); }
  async execute(task: CorpusTask, request: ExecutionRequest): Promise<ExecutionResult> {
    if (request.mode !== "policy") {
      if (!request.requestedEffort) throw new Error(`${request.mode} requires a controlled effort`);
      const outcome = patchProviderPayloadOutcome(this.controlModel, { reasoning: {} }, request.requestedEffort);
      if (outcome.status !== "applied") throw new Error(`${request.mode} control adapter did not apply ${request.requestedEffort}: ${outcome.status}`);
      const effort = selectedEffort(outcome.payload);
      if (effort !== request.requestedEffort) throw new Error(`${request.mode} control adapter applied ${effort}; expected ${request.requestedEffort}`);
      this.controlledAdapterCalls += 1;
      return { output: task.grader.expected, selectedEffort: effort, providerRequests: 1, toolRounds: 0, retries: 0, usage: syntheticUsage, latencyMs: 0 };
    }
    await this.session.setEffort("auto");
    const effort = selectedEffort(this.session.run(task.description));
    this.policyProviderHookCalls += 1;
    this.session.finish();
    return { output: task.grader.expected, selectedEffort: effort, providerRequests: 1, toolRounds: 0, retries: 0, usage: syntheticUsage, latencyMs: 0 };
  }
  /** Drives an explicit lifecycle prompt without making a provider/network request. */
  runLifecycle(prompt: string): AutomaticEffort { return selectedEffort(this.session.run(prompt)); }
  failTool(): void { this.session.failTool(); }
  settle(stopReason: "error" | "length" | "aborted" | "stop" = "stop"): void { this.session.finish(stopReason); }
}
