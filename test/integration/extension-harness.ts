import type {
  AgentSettledEvent, BeforeAgentStartEvent, BeforeProviderRequestEvent, ExtensionAPI,
  ExtensionContext, InputEvent, MessageEndEvent, SessionCompactEvent, SessionShutdownEvent, SessionStartEvent,
  ToolCallEvent, ToolExecutionEndEvent,
} from "@earendil-works/pi-coding-agent";

/** Synthetic harness; each payload is derived from Pi 0.82.1 declarations. */
type LifecycleEvents = {
  session_start: SessionStartEvent; session_shutdown: SessionShutdownEvent; input: InputEvent;
  before_agent_start: BeforeAgentStartEvent; before_provider_request: BeforeProviderRequestEvent;
  tool_call: ToolCallEvent; tool_execution_end: ToolExecutionEndEvent; message_end: MessageEndEvent;
  session_compact: SessionCompactEvent; agent_settled: AgentSettledEvent;
};
type LifecycleHandler<E extends keyof LifecycleEvents> = (event: LifecycleEvents[E], ctx: ExtensionContext) => unknown;
export class ExtensionHarness {
  readonly commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  readonly status = new Map<string, string | undefined>();
  readonly notifications: { message: string; type: string | undefined }[] = [];
  private readonly handlers: { [E in keyof LifecycleEvents]: LifecycleHandler<E>[] } = {
    session_start: [], session_shutdown: [], input: [], before_agent_start: [], before_provider_request: [],
    tool_call: [], tool_execution_end: [], message_end: [], session_compact: [], agent_settled: [],
  };
  readonly context = { model: { provider: "openai", api: "openai-responses", id: "m", reasoning: true }, ui: { setStatus: (key: string, text: string | undefined) => this.status.set(key, text), notify: (message: string, type?: string) => this.notifications.push({ message, type }) } } as unknown as ExtensionContext;
  on<E extends keyof LifecycleEvents>(event: E, handler: LifecycleHandler<E>): void { this.handlers[event].push(handler); }
  registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }): void { this.commands.set(name, options); }
  emit<E extends keyof LifecycleEvents>(name: E, event: LifecycleEvents[E]): unknown { let result: unknown; for (const handler of this.handlers[name]) { const next = handler(event, this.context); if (next !== undefined) result = next; } return result; }
  api(): ExtensionAPI { return this as unknown as ExtensionAPI; }
  start(reason: SessionStartEvent["reason"] = "startup"): void { this.emit("session_start", { type: "session_start", reason } satisfies SessionStartEvent); }
  shutdown(reason: SessionShutdownEvent["reason"] = "new"): void { this.emit("session_shutdown", { type: "session_shutdown", reason } satisfies SessionShutdownEvent); }
  input(text: string, streamingBehavior?: InputEvent["streamingBehavior"]): void { this.emit("input", { type: "input", text, source: "interactive", ...(streamingBehavior ? { streamingBehavior } : {}) } satisfies InputEvent); }
  setModel(model: { provider?: string; api?: string; id?: string }): void { Object.assign((this.context as { model: object }).model, model); }
  before(prompt: string): void { this.emit("before_agent_start", { type: "before_agent_start", prompt, systemPrompt: "", systemPromptOptions: {} } as BeforeAgentStartEvent); }
  request(payload: unknown): unknown { return this.emit("before_provider_request", { type: "before_provider_request", payload } satisfies BeforeProviderRequestEvent); }
  error(): void { this.emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "synthetic", toolName: "read", result: {}, isError: true } satisfies ToolExecutionEndEvent); }
  message(stopReason: "error" | "length" | "aborted" | "stop" | "toolUse"): void { this.emit("message_end", { type: "message_end", message: { role: "assistant", stopReason } } as MessageEndEvent); }
  settled(): void { this.emit("agent_settled", { type: "agent_settled" } satisfies AgentSettledEvent); }
}
