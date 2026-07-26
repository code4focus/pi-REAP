import { createHash } from "node:crypto";
import { higherEffort, isAutomaticEffort, type AutomaticEffort, type Effort } from "../domain/effort.js";
import type { RoutingDecision } from "../domain/routing-decision.js";
import type { SessionRuntime } from "../domain/runtime-state.js";
import type { TaskEpoch } from "../domain/task-epoch.js";
import { classify } from "../policy/classifier.js";
import { extractFeatures, type FeatureInput } from "../policy/features.js";

export interface RouterOptions { now?: () => number; id?: () => string; resumeReason?: "resume" | "fork" | "reload" | "startup" | string }
export interface StartInput extends FeatureInput {}

const automaticFloor = (epoch: TaskEpoch): AutomaticEffort => {
  let floor: Effort = epoch.initialEffort;
  if (epoch.inheritedFloor) floor = higherEffort(floor, epoch.inheritedFloor);
  if (epoch.escalationFloor) floor = higherEffort(floor, epoch.escalationFloor);
  return floor as AutomaticEffort;
};
const promptHash = (prompt: string) => createHash("sha256").update(prompt).digest("hex");

/** In-memory task epoch state. It neither mutates input nor persists routing data. */
export class EpochRouter {
  readonly runtime: SessionRuntime;
  private readonly now: () => number;
  private readonly nextId: () => string;
  private counter = 0;
  private lastDecision?: RoutingDecision;
  private queuedInput?: StartInput;
  private lastPromptChars = 0;

  constructor(options: RouterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.nextId = options.id ?? (() => `epoch-${++this.counter}`);
    this.runtime = { mode: "enforce", pendingRequests: [], resumeGuard: false, sessionStartedAt: this.now() };
    this.setResumeReason(options.resumeReason);
  }

  start(input: StartInput): RoutingDecision {
    this.lastPromptChars = input.prompt.length;
    const features = extractFeatures(input);
    const current = this.runtime.currentEpoch;
    const previous = current ?? this.runtime.previousEpoch;
    const currentActive = current?.status === "active";
    const previousFailed = current?.status === "failed" || this.runtime.previousEpoch?.status === "failed";
    const explicitContinuation = features.continuationSignal === true || features.streamingContinuation === true;
    const explicitNew = features.explicitNewTask === true || (features.simpleQuestion === true && !explicitContinuation);
    const relation: RoutingDecision["relation"] = currentActive || explicitContinuation || previousFailed ? "continuation" : (previous || this.runtime.resumeGuard) && !explicitNew ? "ambiguous" : "new";
    const classified = classify({ features, relation, previousFailed: previousFailed === true, resumeGuard: this.runtime.resumeGuard });
    const inherited = relation === "new" ? undefined : current ? automaticFloor(current) : previous?.taskClass ? this.lastDecision?.selectedEffort : undefined;
    if (relation === "new" && current?.status === "settled") this.retireCurrent();
    const epoch = relation === "continuation" && current ? current : this.createEpoch(classified.effort, classified.taskClass, input.prompt, inherited);
    if (relation !== "continuation" || !current) this.runtime.currentEpoch = epoch;
    epoch.status = "active";
    // A continuation may contribute new hard-floor evidence (for example a
    // failed prior run); apply it to this epoch rather than replacing history.
    if (relation === "continuation") this.raiseEpoch(epoch, classified.effort);
    epoch.lastActivityAt = this.now();
    const selectedEffort = automaticFloor(epoch);
    const effectiveFloor = this.effectiveEffort(epoch);
    const decision: RoutingDecision = { id: this.nextId(), policyVersion: "1.0", epochId: epoch.id, relation, taskClass: classified.taskClass, selectedEffort, effectiveFloor, confidence: classified.confidence, reasons: [...classified.reasons, ...(inherited ? ["PREVIOUS_EPOCH_ACTIVE" as const] : [])], features, timestamp: this.now() };
    epoch.decisionIds.push(decision.id);
    this.lastDecision = decision;
    this.runtime.resumeGuard = false;
    return decision;
  }

  /** Holds one unmodified input only until before_agent_start consumes it. */
  queueInput(input: StartInput): void { this.queuedInput = input; }
  startQueued(): RoutingDecision | undefined { const input = this.queuedInput; delete this.queuedInput; return input ? this.start(input) : undefined; }
  latestPromptChars(): number { return this.lastPromptChars; }
  /** Session lifecycle input; this is in-memory and never enters model history. */
  setResumeReason(reason: string | undefined): void { this.runtime.resumeGuard = ["resume", "fork", "reload", "startup"].includes(reason ?? ""); }

  onProviderRequest(): Effort | undefined { const epoch = this.runtime.currentEpoch; if (!epoch) return undefined; epoch.requestCount += 1; return this.effectiveEffort(epoch); }
  onToolCall(toolName: string): void { const epoch = this.runtime.currentEpoch; if (!epoch) return; epoch.toolCallCount += 1; if (toolName === "edit" || toolName === "write") this.raise("high"); }
  onToolError(): void { const epoch = this.runtime.currentEpoch; if (!epoch) return; epoch.toolErrorCount += 1; this.raise(epoch.toolErrorCount >= 2 ? "xhigh" : "high"); }
  onProviderEnd(stopReason: string | undefined): void { if (stopReason === "error" || stopReason === "length") { const epoch = this.runtime.currentEpoch; if (epoch) epoch.providerErrorCount += 1; this.raise("xhigh"); } }
  onCompaction(reason: string, willRetry: boolean): void { if (reason === "overflow" && willRetry) this.raise("xhigh"); }
  settle(failed = false): void { const epoch = this.runtime.currentEpoch; if (!epoch) return; epoch.status = failed ? "failed" : "settled"; epoch.lastActivityAt = this.now(); this.runtime.previousEpoch = { id: epoch.id, status: epoch.status, taskClass: epoch.taskClass, lastActivityAt: epoch.lastActivityAt }; }
  setManualOverride(effort: Effort | undefined): void { if (effort) this.runtime.manualOverride = { effort, scope: "session" }; else delete this.runtime.manualOverride; }
  effectiveEffort(epoch = this.runtime.currentEpoch): Effort { if (!epoch) return this.runtime.manualOverride?.effort ?? "high"; return this.runtime.manualOverride ? higherEffort(automaticFloor(epoch), this.runtime.manualOverride.effort) : automaticFloor(epoch); }
  status(): string { const epoch = this.runtime.currentEpoch; return `effort:${this.runtime.manualOverride ? this.runtime.manualOverride.effort : "auto"} → ${this.effectiveEffort()}\nepoch:${epoch?.id ?? "none"} ${epoch?.status ?? "none"}\nreason:${this.lastDecision?.reasons[0] ?? "none"}\nmode:${this.runtime.mode}`; }

  private createEpoch(initialEffort: AutomaticEffort, taskClass: TaskEpoch["taskClass"], prompt: string, inheritedFloor?: AutomaticEffort): TaskEpoch { const now = this.now(); return { id: this.nextId(), createdAt: now, lastActivityAt: now, status: "active", taskClass, initialEffort, ...(inheritedFloor ? { inheritedFloor } : {}), requestCount: 0, toolCallCount: 0, toolErrorCount: 0, providerErrorCount: 0, lastPromptHash: promptHash(prompt), decisionIds: [] }; }
  private retireCurrent(): void { const epoch = this.runtime.currentEpoch; if (epoch) epoch.status = "retired"; }
  private raise(floor: AutomaticEffort): void { const epoch = this.runtime.currentEpoch; if (epoch) this.raiseEpoch(epoch, floor); }
  private raiseEpoch(epoch: TaskEpoch, floor: AutomaticEffort): void { epoch.escalationFloor = epoch.escalationFloor ? higherEffort(epoch.escalationFloor, floor) as AutomaticEffort : floor; }
}

export function parseEffortCommand(input: string, router: EpochRouter): boolean {
  const match = /^\/effort\s+(status|auto|low|medium|high|xhigh|max|shadow|enforce)\s*$/.exec(input);
  if (!match) return false;
  const command = match[1];
  if (command === "auto") router.setManualOverride(undefined);
  else if (command === "shadow" || command === "enforce") router.runtime.mode = command;
  else if (command !== "status" && isAutomaticEffort(command as Effort) || command === "max") router.setManualOverride(command as Effort);
  return true;
}
