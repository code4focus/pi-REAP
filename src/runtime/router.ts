import { createHash } from "node:crypto";
import {
  isTrustedProfileActivationSnapshot,
  sameProfileBinding,
  sameProfileMatch,
  type ProfileActivationSnapshot,
  type ProfileBinding,
  type ResolvedRung,
} from "../domain/profile.js";
import type { EffortRouterConfig } from "../config/schema.js";
import type { RoutingDecision } from "../domain/routing-decision.js";
import type { SessionRuntime } from "../domain/runtime-state.js";
import type { TaskEpoch } from "../domain/task-epoch.js";
import { classify } from "../policy/classifier.js";
import { extractFeatures, type FeatureInput } from "../policy/features.js";

export interface RouterOptions {
  now?: () => number;
  id?: () => string;
  resumeReason?: string;
  config?: Pick<EffortRouterConfig, "mode" | "ui">;
}
export interface StartInput extends FeatureInput {}

type ActiveProfile = Extract<ProfileActivationSnapshot, { status: "ready" }>;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const higher = (left: ResolvedRung, right: ResolvedRung): ResolvedRung => left.ordinal >= right.ordinal ? left : right;
const sameBinding = sameProfileBinding;

/** Session-local policy state. A request is eligible only while its exact activation remains current. */
export class EpochRouter {
  readonly runtime: SessionRuntime;
  private readonly now: () => number;
  private readonly nextId: () => string;
  private counter = 0;
  private queuedInput?: StartInput;
  private lastDecision?: RoutingDecision;
  private active?: ActiveProfile;
  private activationGeneration = 0;

  constructor(options: RouterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.nextId = options.id ?? (() => `epoch-${++this.counter}`);
    this.runtime = {
      mode: options.config?.mode ?? "shadow",
      pendingRequests: [],
      resumeGuard: false,
      sessionStartedAt: this.now(),
    };
    this.setResumeReason(options.resumeReason);
  }

  /** Activate an already validated detached snapshot without per-hook digest work. */
  activateSnapshot(match: ProfileBinding["match"], snapshot: ProfileActivationSnapshot, options: { preserveQueuedInput?: boolean } = {}): boolean {
    if (!isTrustedProfileActivationSnapshot(snapshot) || snapshot.status !== "ready" || !sameProfileMatch(match, snapshot.binding.match)) {
      this.invalidate();
      return false;
    }
    if (this.active && !sameBinding(this.active.binding, snapshot.binding)) this.clearActivation(options);
    this.active = snapshot;
    return true;
  }

  get generation(): number { return this.activationGeneration; }

  /** A candidate, mismatch, or unresolved identity revokes every decision and transient correlation. */
  invalidate(options: { preserveQueuedInput?: boolean } = {}): void {
    if (this.active || this.runtime.currentEpoch || this.runtime.previousEpoch || this.queuedInput || this.runtime.pendingInput
      || this.runtime.pendingRequests.length > 0 || this.lastDecision || this.runtime.manualOverride) {
      this.clearActivation(options);
    }
  }

  private clearActivation(options: { preserveQueuedInput?: boolean } = {}): void {
    const queued = options.preserveQueuedInput ? this.queuedInput : undefined;
    const pending = options.preserveQueuedInput ? this.runtime.pendingInput : undefined;
    if (this.runtime.currentEpoch) this.runtime.currentEpoch.status = "retired";
    delete this.active;
    delete this.runtime.currentEpoch;
    delete this.runtime.previousEpoch;
    delete this.runtime.manualOverride;
    delete this.lastDecision;
    if (queued) this.queuedInput = queued; else delete this.queuedInput;
    if (pending) this.runtime.pendingInput = pending; else delete this.runtime.pendingInput;
    this.runtime.pendingRequests.length = 0;
    this.activationGeneration += 1;
  }

  /** Provider adapter material exists only after an active decision under the exact active binding. */
  providerInput(): {
    readonly boundSelection: unknown;
  } | undefined {
    const epoch = this.runtime.currentEpoch;
    const rung = this.effectiveRung(epoch);
    if (!this.active || !epoch || epoch.status !== "active" || !rung || !this.lastDecision
      || this.lastDecision.epochId !== epoch.id
      || !sameBinding(rung.binding, this.active.binding)
      || !sameBinding(this.lastDecision.selectedRung.binding, this.active.binding)) return undefined;
    const boundSelection = Object.hasOwn(this.active.routing.provider, rung.rungId)
      ? this.active.routing.provider[rung.rungId]
      : undefined;
    return boundSelection ? { boundSelection } : undefined;
  }

  start(input: StartInput): RoutingDecision | undefined {
    if (!this.active) return undefined;
    const features = extractFeatures(input);
    const current = this.runtime.currentEpoch;
    const continuation = features.continuationSignal === true || features.streamingContinuation === true;
    const standalone = !continuation && (
      features.explicitNewTask === true || features.simpleQuestion === true || features.boundedRead === true
      || features.codeChange === true || features.testsRequested === true || features.longRunningGoal === true
      || features.multiStage === true || features.highRisk === true
    );
    const relation: RoutingDecision["relation"] = current?.status === "active" || continuation
      ? "continuation"
      : standalone ? "new" : (current || this.runtime.previousEpoch || this.runtime.resumeGuard) ? "ambiguous" : "new";
    const predecessor = current?.status === "active" ? undefined : this.runtime.previousEpoch;
    const previousFailed = relation === "continuation" && (current?.status === "failed" || predecessor?.status === "failed");
    const classified = classify({ features, relation, previousFailed, resumeGuard: this.runtime.resumeGuard });
    const initial = this.resolveInitial(classified.taskClass, relation);
    if (!initial) return undefined;

    let epoch: TaskEpoch;
    if (relation === "continuation" && current?.status === "active" && sameBinding(current.initialRung.binding, initial.binding)) {
      epoch = current;
      this.raise(epoch, initial);
      if (previousFailed) this.escalate(epoch, "failedContinuation");
    } else {
      if (current?.status === "active" && !sameBinding(current.initialRung.binding, initial.binding)) current.status = "retired";
      epoch = this.createEpoch(initial, classified.taskClass, input.prompt);
      if (relation === "ambiguous" && predecessor?.status === "settled" && sameBinding(predecessor.effectiveRung.binding, initial.binding)) {
        epoch.inheritedFloor = predecessor.effectiveRung;
      }
      this.runtime.currentEpoch = epoch;
      if (previousFailed) this.escalate(epoch, "failedContinuation");
    }
    epoch.status = "active";
    epoch.lastActivityAt = this.now();
    this.runtime.resumeGuard = false;
    const automatic = this.automaticFloor(epoch);
    if (!automatic) return undefined;
    const decision: RoutingDecision = {
      id: this.nextId(),
      policyVersion: "1.0",
      epochId: epoch.id,
      relation,
      taskClass: classified.taskClass,
      selectedRung: automatic,
      effectiveFloor: this.effectiveRung(epoch) ?? automatic,
      confidence: classified.confidence === "high" ? "strong" : classified.confidence === "medium" ? "moderate" : "weak",
      reasons: classified.reasons,
      features,
      timestamp: this.now(),
    };
    epoch.decisionIds.push(decision.id);
    this.lastDecision = decision;
    return decision;
  }

  queueInput(input: StartInput): void {
    this.queuedInput = input;
    this.runtime.pendingInput = { id: this.nextId(), receivedAt: this.now() };
  }

  /** `before_agent_start.prompt` is canonical, while input metadata survives expansion. */
  replaceQueuedPrompt(prompt: string): boolean {
    if (!this.queuedInput) return false;
    this.queuedInput = { ...this.queuedInput, prompt };
    return true;
  }

  startQueued(): RoutingDecision | undefined {
    const input = this.queuedInput;
    delete this.queuedInput;
    delete this.runtime.pendingInput;
    return input ? this.start(input) : undefined;
  }

  setResumeReason(reason: string | undefined): void {
    this.runtime.resumeGuard = ["resume", "fork", "reload", "startup"].includes(reason ?? "");
  }

  onProviderRequest(): ResolvedRung | undefined {
    const epoch = this.runtime.currentEpoch;
    if (!epoch || !this.providerInput()) return undefined;
    epoch.requestCount += 1;
    return this.effectiveRung(epoch);
  }

  onToolCall(_toolName: string): void {
    const epoch = this.runtime.currentEpoch;
    if (epoch?.status === "active") epoch.toolCallCount += 1;
  }

  onToolError(): void {
    const epoch = this.runtime.currentEpoch;
    if (!epoch || epoch.status !== "active") return;
    epoch.toolErrorCount += 1;
    this.escalate(epoch, epoch.toolErrorCount === 1 ? "firstToolError" : "repeatedToolError");
  }

  onProviderEnd(stopReason: string | undefined): void {
    const epoch = this.runtime.currentEpoch;
    if (!epoch || epoch.status !== "active") return;
    if (stopReason === "error") { epoch.providerErrorCount += 1; this.escalate(epoch, "providerError"); }
    if (stopReason === "length") { epoch.providerErrorCount += 1; this.escalate(epoch, "lengthExhaustion"); }
  }

  onCompaction(reason: string, willRetry: boolean): void {
    const epoch = this.runtime.currentEpoch;
    if (epoch?.status === "active" && reason === "overflow" && willRetry) this.escalate(epoch, "overflowRetry");
  }

  settle(failed = false): void {
    const epoch = this.runtime.currentEpoch;
    const effective = this.effectiveRung(epoch);
    if (!epoch || !effective) return;
    epoch.status = failed ? "failed" : "settled";
    epoch.lastActivityAt = this.now();
    this.runtime.previousEpoch = {
      id: epoch.id,
      status: epoch.status,
      taskClass: epoch.taskClass,
      lastActivityAt: epoch.lastActivityAt,
      effectiveRung: effective,
    };
  }

  /** Only exact, unique profile-local IDs/aliases may select an optional explicit ceiling. */
  setManualOverride(name: string | undefined): boolean {
    if (!name) {
      const epoch = this.runtime.currentEpoch;
      const effective = this.effectiveRung(epoch);
      if (epoch?.status === "active" && effective) this.raise(epoch, effective);
      delete this.runtime.manualOverride;
      return true;
    }
    if (!this.active) return false;
    if (name === "prototype" || Object.hasOwn(Object.prototype, name)) return false;
    const rung = Object.hasOwn(this.active.routing.manual, name) ? this.active.routing.manual[name] : undefined;
    if (!rung) return false;
    const epoch = this.runtime.currentEpoch;
    const effective = this.effectiveRung(epoch);
    if (epoch?.status === "active" && effective && sameBinding(effective.binding, rung.binding) && rung.ordinal < effective.ordinal) {
      this.raise(epoch, effective);
    }
    this.runtime.manualOverride = {
      rung,
      scope: "session",
    };
    return true;
  }

  effectiveRung(epoch = this.runtime.currentEpoch): ResolvedRung | undefined {
    const automatic = epoch && this.automaticFloor(epoch);
    const manual = this.runtime.manualOverride?.rung;
    if (!automatic) return undefined;
    return manual && sameBinding(manual.binding, automatic.binding) ? higher(automatic, manual) : automatic;
  }

  status(): string {
    const epoch = this.runtime.currentEpoch;
    const rung = this.effectiveRung(epoch);
    return `profile:${this.active ? `${this.active.binding.capability.profileId}@${this.active.binding.capability.profileRevision}` : "unresolved"}`
      + `\nrung:${this.runtime.manualOverride?.rung.rungId ?? "auto"} → ${rung?.rungId ?? "baseline"}`
      + `\nepoch:${epoch?.id ?? "none"} ${epoch?.status ?? "none"}`
      + `\nreason:${this.lastDecision?.reasons[0] ?? "none"}`
      + `\nmode:${this.runtime.mode}`;
  }

  private resolveInitial(taskClass: TaskEpoch["taskClass"], relation: RoutingDecision["relation"]): ResolvedRung | undefined {
    if (!this.active) return undefined;
    const key = relation !== "new" ? "continuation"
      : taskClass === "simple_query" ? "simpleQuery"
      : taskClass === "bounded_read" ? "boundedRead"
      : taskClass === "implementation" ? "implementation"
      : taskClass === "debugging" ? "debugging"
      : taskClass === "architecture" ? "architecture"
      : taskClass === "high_risk" ? "highRisk" : "unknown";
    return this.active.routing.initial[key];
  }

  private createEpoch(initialRung: ResolvedRung, taskClass: TaskEpoch["taskClass"], prompt: string): TaskEpoch {
    const now = this.now();
    return { id: this.nextId(), createdAt: now, lastActivityAt: now, status: "active", taskClass, initialRung, requestCount: 0, toolCallCount: 0, toolErrorCount: 0, providerErrorCount: 0, lastPromptHash: hash(prompt), decisionIds: [] };
  }

  private automaticFloor(epoch: TaskEpoch): ResolvedRung {
    let floor = epoch.initialRung;
    if (epoch.inheritedFloor && sameBinding(epoch.inheritedFloor.binding, floor.binding)) floor = higher(floor, epoch.inheritedFloor);
    if (epoch.escalationFloor && sameBinding(epoch.escalationFloor.binding, floor.binding)) floor = higher(floor, epoch.escalationFloor);
    return floor;
  }

  private raise(epoch: TaskEpoch, rung: ResolvedRung): void {
    if (!sameBinding(epoch.initialRung.binding, rung.binding)) return;
    epoch.escalationFloor = epoch.escalationFloor ? higher(epoch.escalationFloor, rung) : rung;
  }

  private escalate(epoch: TaskEpoch, key: keyof ActiveProfile["routing"]["evidence"]): void {
    if (!this.active || !sameBinding(epoch.initialRung.binding, this.active.binding)) return;
    this.raise(epoch, this.active.routing.evidence[key]);
  }
}

export function parseEffortCommand(input: string, router: EpochRouter): boolean {
  const match = /^\/effort\s+([^\s]+)\s*$/.exec(input);
  if (!match) return false;
  const command = match[1]!;
  if (command === "status") return true;
  if (command === "auto") return router.setManualOverride(undefined);
  if (command === "shadow" || command === "enforce") { router.runtime.mode = command; return true; }
  return router.setManualOverride(command);
}
