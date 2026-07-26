import type { PiContext, PiExtensionHost, PiLifecycleEvents } from "../../src/index.js";

export interface SyntheticModel { id: string; provider: string; api?: unknown; reasoning?: unknown; thinkingLevelMap?: unknown }
export interface SyntheticAssistantUsage { inputTokens: number; outputTokens: number; reasoningTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
export interface SyntheticContext { model: SyntheticModel; assistantUsage?: SyntheticAssistantUsage }
export interface SyntheticToolError { toolName: string; message: string }
export interface SyntheticSession { id: string }

export interface LifecycleEvents extends PiLifecycleEvents {
  assistant_usage: { ctx: SyntheticContext; usage: SyntheticAssistantUsage };
  tool_error: { ctx: SyntheticContext; error: SyntheticToolError };
  session_replaced: { previous: SyntheticSession; next: SyntheticSession };
  compaction_retry: { ctx: SyntheticContext; attempt: number };
  message_queued: { ctx: SyntheticContext; messageId: string };
}

export type LifecycleHandler<E extends keyof LifecycleEvents> =
  (event: LifecycleEvents[E]) => void | Partial<LifecycleEvents[E]>;

export class ExtensionHarness implements PiExtensionHost {
  readonly registerToolCalls: unknown[] = [];
  readonly setThinkingLevelCalls: string[] = [];
  readonly commands = new Map<string, { description?: string; handler: (input: string, context: PiContext) => void | Promise<void> }>();
  private readonly handlers: { [E in keyof LifecycleEvents]: LifecycleHandler<E>[] } = {
    session_start: [], input: [], before_agent_start: [], assistant_usage: [], tool_error: [], session_replaced: [], compaction_retry: [], agent_settled: [], message_queued: [], before_provider_request: [], tool_call: [], tool_execution_end: [], message_end: [], session_compact: [],
  };

  registerTool(definition: unknown): void { this.registerToolCalls.push(definition); }
  setThinkingLevel(level: string): void { this.setThinkingLevelCalls.push(level); }
  registerCommand(name: string, options: { description?: string; handler: (input: string, context: PiContext) => void | Promise<void> }): void { this.commands.set(name, options); }
  on<E extends keyof LifecycleEvents>(event: E, handler: LifecycleHandler<E>): void { this.handlers[event].push(handler); }

  emit<E extends keyof LifecycleEvents>(event: E, initial: LifecycleEvents[E]): LifecycleEvents[E] {
    return this.handlers[event].reduce<LifecycleEvents[E]>((current, handler) => ({ ...current, ...handler(current) }), initial);
  }
}
