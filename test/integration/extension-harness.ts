import type {
  AgentSettledEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  BeforeProviderRequestEvent,
  BeforeProviderRequestEventResult,
} from "@earendil-works/pi-coding-agent";
import type { NoOpExtensionAPI } from "../../src/index.js";

/** The harness is synthetic, but its event payloads come from Pi 0.82.1. */
export type LifecycleEventName = "before_agent_start" | "before_provider_request" | "agent_settled";
export interface LifecycleEvents {
  before_agent_start: BeforeAgentStartEvent;
  before_provider_request: BeforeProviderRequestEvent;
  agent_settled: AgentSettledEvent;
}

export interface LifecycleResults {
  before_agent_start: BeforeAgentStartEventResult;
  before_provider_request: BeforeProviderRequestEventResult;
  agent_settled: undefined;
}

export interface BeforeAgentStartHarnessResult {
  messages?: NonNullable<BeforeAgentStartEventResult["message"]>[];
  systemPrompt?: BeforeAgentStartEvent["systemPrompt"];
};

export type LifecycleHandler<E extends keyof LifecycleEvents> =
  (event: LifecycleEvents[E]) => void | LifecycleResults[E];

export class ExtensionHarness implements NoOpExtensionAPI {
  readonly registerToolCalls: unknown[] = [];
  readonly setThinkingLevelCalls: Parameters<NoOpExtensionAPI["setThinkingLevel"]>[0][] = [];
  private readonly handlers: { [E in keyof LifecycleEvents]: LifecycleHandler<E>[] } = {
    before_agent_start: [], before_provider_request: [], agent_settled: [],
  };

  registerTool(definition: unknown): void { this.registerToolCalls.push(definition); }
  setThinkingLevel(level: Parameters<NoOpExtensionAPI["setThinkingLevel"]>[0]): void { this.setThinkingLevelCalls.push(level); }
  on<E extends keyof LifecycleEvents>(event: E, handler: LifecycleHandler<E>): void { this.handlers[event].push(handler); }

  emitBeforeAgentStart(initial: BeforeAgentStartEvent): BeforeAgentStartHarnessResult | undefined {
    const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];
    let currentSystemPrompt = initial.systemPrompt;
    let systemPromptModified = false;

    for (const handler of this.handlers.before_agent_start) {
      const result = handler({ ...initial, systemPrompt: currentSystemPrompt });
      if (result?.message) messages.push(result.message);
      if (result?.systemPrompt !== undefined) {
        currentSystemPrompt = result.systemPrompt;
        systemPromptModified = true;
      }
    }

    if (messages.length === 0 && !systemPromptModified) return undefined;
    return {
      ...(messages.length > 0 ? { messages } : {}),
      ...(systemPromptModified ? { systemPrompt: currentSystemPrompt } : {}),
    };
  }

  emitBeforeProviderRequest(initial: BeforeProviderRequestEvent["payload"]): BeforeProviderRequestEventResult {
    let currentPayload = initial;
    for (const handler of this.handlers.before_provider_request) {
      const result = handler({ type: "before_provider_request", payload: currentPayload });
      if (result !== undefined) currentPayload = result;
    }
    return currentPayload;
  }

  emitAgentSettled(): void {
    for (const handler of this.handlers.agent_settled) handler({ type: "agent_settled" });
  }
}
