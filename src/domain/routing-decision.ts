import type { ResolvedRung, RungSelector } from "./profile.js";
import type { TaskClass } from "./task-epoch.js";

export type ReasonCode =
  | "EXPLICIT_SIMPLE_QUERY"
  | "BOUNDED_READ_ONLY"
  | "CODE_CHANGE_REQUESTED"
  | "DEBUG_OR_FAILURE"
  | "MULTI_STAGE_TASK"
  | "HIGH_RISK_DOMAIN"
  | "CONTINUATION_REFERENCE"
  | "PREVIOUS_EPOCH_ACTIVE"
  | "PREVIOUS_EPOCH_FAILED"
  | "RESUMED_SESSION_AMBIGUOUS"
  | "AMBIGUOUS_CONSERVATIVE_DEFAULT"
  | "MANUAL_OVERRIDE"
  | "TOOL_ERROR_ESCALATION"
  | "PROVIDER_ERROR_ESCALATION";

/** A deliberately non-textual, policy-facing feature summary. */
export interface RoutingFeatures {
  readonly [feature: string]: boolean | number | string | undefined;
}

export interface RoutingDecision {
  id: string;
  policyVersion: string;
  epochId: string;
  relation: "new" | "continuation" | "ambiguous";
  taskClass: TaskClass;
  /** Exact factory-compiled admission selector, never inferred from the rung. */
  selector: RungSelector;
  selectedRung: ResolvedRung;
  effectiveFloor: ResolvedRung;
  confidence: "strong" | "moderate" | "weak";
  reasons: ReasonCode[];
  features: RoutingFeatures;
  timestamp: number;
}
