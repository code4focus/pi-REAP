import type { AutomaticEffort } from "./effort.js";

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
  initialEffort: AutomaticEffort;
  inheritedFloor?: AutomaticEffort;
  escalationFloor?: AutomaticEffort;
  requestCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  providerErrorCount: number;
  lastPromptHash: string;
  decisionIds: string[];
}
