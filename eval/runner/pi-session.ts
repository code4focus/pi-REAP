import type { AgentSettledEvent, BeforeAgentStartEvent, BeforeProviderRequestEvent, BuildSystemPromptOptions, ExtensionAPI, ExtensionContext, InputEvent, MessageEndEvent, SessionCompactEvent, SessionShutdownEvent, SessionStartEvent, ToolCallEvent, ToolExecutionEndEvent } from "@earendil-works/pi-coding-agent";
import { createExtension, type ExtensionOptions } from "../../src/index.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CorpusTask } from "../corpus/types.js";
import { observeTelemetry, observeTelemetrySequence } from "./observations.js";
import type { EvaluationExecutor, ExecutionRequest, ExecutionResult } from "./types.js";
type Events = { session_start: SessionStartEvent; session_shutdown: SessionShutdownEvent; input: InputEvent; before_agent_start: BeforeAgentStartEvent; before_provider_request: BeforeProviderRequestEvent; tool_call: ToolCallEvent; tool_execution_end: ToolExecutionEndEvent; message_end: MessageEndEvent; session_compact: SessionCompactEvent; agent_settled: AgentSettledEvent };
type Handler<E extends keyof Events> = (event: Events[E], context: ExtensionContext) => unknown;
const options: BuildSystemPromptOptions = { cwd: process.cwd() };
class SyntheticPi {
  private readonly handlers: { [E in keyof Events]: Handler<E>[] } = { session_start: [], session_shutdown: [], input: [], before_agent_start: [], before_provider_request: [], tool_call: [], tool_execution_end: [], message_end: [], session_compact: [], agent_settled: [] };
  readonly commands = new Map<string, { handler: (args: string, context: ExtensionContext) => Promise<void> }>();
  private readonly context = { cwd: process.cwd(), model: { id: "synthetic-evaluation", provider: "openai", api: "openai-responses", reasoning: true }, sessionManager: { getSessionId: () => "synthetic-evaluation" }, ui: { setStatus: () => undefined, notify: () => undefined } } as unknown as ExtensionContext;
  on<E extends keyof Events>(event: E, handler: Handler<E>): void { this.handlers[event].push(handler); }
  registerCommand(name: string, value: { handler: (args: string, context: ExtensionContext) => Promise<void> }): void { this.commands.set(name, value); }
  private emit<E extends keyof Events>(event: E, value: Events[E]): unknown { let result: unknown; for (const handler of this.handlers[event]) { const next = handler(value, this.context); if (next !== undefined) result = next; } return result; }
  api(): ExtensionAPI { return { on: this.on.bind(this), registerCommand: this.registerCommand.bind(this) } as ExtensionAPI; }
  start(): void { this.emit("session_start", { type: "session_start", reason: "startup" } satisfies SessionStartEvent); }
  setModel(model: Partial<{ id: string; provider: string; api: string }>): void { Object.assign((this.context as unknown as { model: object }).model, model); }
  shutdown(): void { this.emit("session_shutdown", { type: "session_shutdown", reason: "new" } satisfies SessionShutdownEvent); }
  async effort(value: string): Promise<void> { await this.commands.get("effort")?.handler(value, this.context); }
  agentStart(prompt: string): void { this.emit("before_agent_start", { type: "before_agent_start", prompt, systemPrompt: "", systemPromptOptions: options } satisfies BeforeAgentStartEvent); }
  request(prompt: string, payload: unknown): unknown { this.emit("input", { type: "input", text: prompt, source: "interactive" } satisfies InputEvent); this.agentStart(prompt); return this.emit("before_provider_request", { type: "before_provider_request", payload } satisfies BeforeProviderRequestEvent); }
  provider(payload: unknown): unknown { return this.emit("before_provider_request", { type: "before_provider_request", payload } satisfies BeforeProviderRequestEvent); }
  fail(): void { this.emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "synthetic", toolName: "read", result: {}, isError: true } satisfies ToolExecutionEndEvent); }
  messageEnd(stopReason: "error" | "length" | "aborted" | "stop" = "stop", syntheticProviderOutput?: string): void { this.emit("message_end", { type: "message_end", message: { role: "assistant", stopReason, ...(syntheticProviderOutput === undefined ? {} : { content: [{ type: "text", text: syntheticProviderOutput }] }) } } as MessageEndEvent); }
  agentSettled(): void { this.emit("agent_settled", { type: "agent_settled" } satisfies AgentSettledEvent); }
  compactOverflowRetry(): void { this.emit("session_compact", { type: "session_compact", compactionEntry: {} as never, fromExtension: false, reason: "overflow", willRetry: true } satisfies SessionCompactEvent); }
  settle(stopReason: "error" | "length" | "aborted" | "stop" = "stop", syntheticProviderOutput?: string): void { this.messageEnd(stopReason, syntheticProviderOutput); this.agentSettled(); }
}
/** The sample executor drives typed Pi 0.82.1 lifecycle events and only observes production hooks. */
export class PiSessionExecutor implements EvaluationExecutor {
  private constructor(private readonly base: Omit<ExtensionOptions, "activation">) {}
  static async create(options: ExtensionOptions): Promise<PiSessionExecutor> { return new PiSessionExecutor(options); }
  async execute(task: CorpusTask, request: ExecutionRequest): Promise<ExecutionResult> {
    const harnessStartedAt = performance.now();
    const pi = new SyntheticPi(); const mode = request.mode === "baseline" ? "shadow" : "enforce";
    const directory = mkdtempSync(join(process.cwd(), "eval", ".tmp-telemetry-"));
    const boundary = task.boundary?.kind ?? "factory-activation";
    const activation = boundary === "missing-activation" ? undefined : { capability: task.profile.capability, admission: task.profile.admission, modelCatalogRevision: task.boundary?.attestation?.modelCatalogRevision ?? task.profile.capability.match.modelCatalogRevision, modelCatalogDigest: task.boundary?.attestation?.modelCatalogDigest ?? task.profile.capability.match.modelCatalogDigest, piVersion: task.boundary?.attestation?.piVersion ?? task.profile.capability.match.piVersion, providerAdapterRevision: task.boundary?.attestation?.providerAdapterRevision ?? task.profile.capability.match.providerAdapterRevision, providerAdapterDigest: task.boundary?.attestation?.providerAdapterDigest ?? task.profile.capability.match.providerAdapterDigest };
    await createExtension({ ...this.base, load: async () => ({ enabled: true, mode, telemetry: { enabled: true, includePromptText: false, directory }, ui: { showStatus: false, notifyOnEscalation: false } }), ...(activation ? { activation } : {}) })(pi.api()); pi.start();
    if (task.boundary?.model) pi.setModel({ ...(task.boundary.model.model === undefined ? {} : { id: task.boundary.model.model }), ...(task.boundary.model.provider === undefined ? {} : { provider: task.boundary.model.provider }), ...(task.boundary.model.api === undefined ? {} : { api: task.boundary.model.api }) });
    if (request.mode !== "baseline") await pi.effort("enforce");
    if (request.mode === "manual-diagnostic") await pi.effort(request.requestedRungId ?? "auto"); else await pi.effort("auto");
    const scenario = request.scenario ?? { kind: "initial", admissionCase: "simpleQuery", prompt: "What is JSON?" };
    const payload = () => ({ reasoning: { effort: "baseline" }, cache: { read: 0, write: 0 } });
    const syntheticProviderOutput = `synthetic-${task.id}-answer`;
    if (scenario.kind === "initial") {
      const hookReturn = pi.request(scenario.prompt, payload()); pi.settle("stop", syntheticProviderOutput);
      const observed = observeTelemetry(directory, hookReturn, syntheticProviderOutput); rmSync(directory, { recursive: true, force: true });
      return { expected: { baselineArm: request.mode === "baseline", expectedOutput: task.expectedOutput, provenance: "synthetic-oracle" }, observed, activationBoundary: boundary, providerRequests: 1, toolRounds: 0, harnessLatencyMs: performance.now() - harnessStartedAt };
    }
    const beforeHook = pi.request(scenario.initialPrompt, payload());
    if (scenario.trigger === "providerError" || scenario.trigger === "failedContinuation") pi.messageEnd("error");
    else if (scenario.trigger === "lengthExhaustion") pi.messageEnd("length");
    else if (scenario.trigger === "overflowRetry") { pi.messageEnd("aborted"); pi.compactOverflowRetry(); }
    else pi.messageEnd("stop");
    for (let index = 0; index < scenario.toolErrors; index += 1) pi.fail();
    if (scenario.trigger === "failedContinuation") pi.agentSettled();
    const afterHook = pi.request(scenario.followupPrompt, payload());
    pi.settle("stop", syntheticProviderOutput);
    const sequence = observeTelemetrySequence(directory, [beforeHook, afterHook], syntheticProviderOutput);
    rmSync(directory, { recursive: true, force: true });
    const observed = sequence.kind === "observed-sequence" ? sequence.after : sequence;
    return { expected: { baselineArm: false, expectedOutput: task.expectedOutput, provenance: "synthetic-oracle" }, observed, activationBoundary: boundary, providerRequests: 2, toolRounds: scenario.toolErrors, harnessLatencyMs: performance.now() - harnessStartedAt, ...(sequence.kind === "observed-sequence" ? { evidence: { trigger: scenario.trigger, before: sequence.before, after: sequence.after } } : {}) };
  }
  async lifecycle(task: CorpusTask, steps: readonly ("settle" | "fail" | "manual" | "switch")[]): Promise<void> { for (const step of steps) await this.execute(task, { mode: step === "manual" ? "manual-diagnostic" : "policy", ...(step === "manual" ? { requestedRungId: task.profile.capability.explicitCeiling } : {}), scenario: { kind: "initial", admissionCase: "boundedRead", prompt: "Explain this file." } }); }
  /** One factory/registration and one live session exercise correlation, manual command, and replacement boundaries. */
  async sameSessionLifecycle(task: CorpusTask): Promise<readonly Record<string, unknown>[]> {
    const directory = mkdtempSync(join(process.cwd(), "eval", ".tmp-telemetry-")); const pi = new SyntheticPi();
    const activation = { capability: task.profile.capability, admission: task.profile.admission, modelCatalogRevision: task.profile.capability.match.modelCatalogRevision, modelCatalogDigest: task.profile.capability.match.modelCatalogDigest, piVersion: task.profile.capability.match.piVersion, providerAdapterRevision: task.profile.capability.match.providerAdapterRevision, providerAdapterDigest: task.profile.capability.match.providerAdapterDigest };
    await createExtension({ ...this.base, load: async () => ({ enabled: true, mode: "enforce", telemetry: { enabled: true, includePromptText: false, directory }, ui: { showStatus: false, notifyOnEscalation: false } }), activation })(pi.api());
    pi.start(); await pi.effort("enforce"); pi.request("Implement a complex synthetic feature.", { reasoning: { effort: "baseline" } }); pi.settle();
    pi.request("Read this bounded synthetic file.", { reasoning: { effort: "baseline" } }); pi.settle();
    pi.request("continue", { reasoning: { effort: "baseline" } }); pi.fail(); pi.settle("error");
    pi.request("continue", { reasoning: { effort: "baseline" } }); pi.settle();
    pi.request("Implement another complex synthetic feature.", { reasoning: { effort: "baseline" } }); pi.settle("length");
    pi.request("continue", { reasoning: { effort: "baseline" } }); pi.settle();
    await pi.effort(task.profile.capability.explicitCeiling ?? "auto"); pi.request("Read this bounded synthetic file.", { reasoning: { effort: "baseline" } }); pi.provider({ reasoning: { effort: "baseline" } }); pi.settle();
    pi.shutdown(); pi.start(); pi.request("Read this bounded synthetic file.", { reasoning: { effort: "baseline" } }); pi.settle();
    const records = ["decisions.jsonl", "requests.jsonl", "epochs.jsonl"].flatMap((file) => { try { return readFileSync(join(directory, file), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>); } catch { return []; } }); rmSync(directory, { recursive: true, force: true }); return records;
  }
}
