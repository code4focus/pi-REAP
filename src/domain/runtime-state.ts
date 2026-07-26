import type { Effort } from "./effort.js";
import type { TaskEpoch } from "./task-epoch.js";

export interface EpochSummary {
  id: string;
  status: TaskEpoch["status"];
  taskClass: TaskEpoch["taskClass"];
  lastActivityAt: number;
}

export interface PendingInput {
  id: string;
  receivedAt: number;
}

export interface PendingRequest {
  id: string;
  startedAt: number;
}

export interface SessionRuntime {
  mode: "shadow" | "enforce";
  currentEpoch?: TaskEpoch;
  previousEpoch?: EpochSummary;
  pendingInput?: PendingInput;
  pendingRequests: PendingRequest[];
  manualOverride?: { effort: Effort; scope: "session" };
  resumeGuard: boolean;
  sessionStartedAt: number;
}
