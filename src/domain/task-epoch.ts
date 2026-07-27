import type { ResolvedRung, RungSelector } from "./profile.js";

export type EpochStatus = "active" | "settled" | "failed" | "retired";

export type TaskClass =
  | "simple_query"
  | "bounded_read"
  | "implementation"
  | "debugging"
  | "architecture"
  | "high_risk"
  | "continuation"
  | "unknown";

export interface TaskEpoch {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  status: EpochStatus;
  taskClass: TaskClass;
  initialRung: ResolvedRung;
  initialSelector: RungSelector;
  inheritedFloor?: ResolvedRung;
  escalationFloor?: ResolvedRung;
  /** Evidence selector that last raised the automatic floor, if any. */
  escalationSelector?: RungSelector;
  requestCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  providerErrorCount: number;
  lastPromptHash: string;
  decisionIds: string[];
}
