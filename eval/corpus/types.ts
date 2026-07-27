import type { AutomaticEffort } from "../../src/domain/effort.js";
import type { TaskClass } from "../../src/domain/task-epoch.js";

export type CorpusMode = "smoke" | "calibration" | "regression";
export interface CorpusTask { readonly id: string; readonly mode: CorpusMode; readonly taskClass: TaskClass; readonly provenance: "synthetic" | "sanitized_real"; readonly description: string; readonly acceptedEfforts: readonly AutomaticEffort[]; readonly candidateEfforts: readonly AutomaticEffort[]; readonly grader: { readonly kind: "exact"; readonly expected: string }; /** A known under-route that must have review evidence in every regression run. */ readonly underRoutingFixture?: true; /** An allowance candidate; a rejection remains reviewable but not critical. */ readonly nonCriticalRejection?: true }
export interface StageRequirement { readonly minimumTasks: number; readonly repetitions: number; readonly requiredCandidateEfforts?: readonly AutomaticEffort[] }
export interface CorpusManifest { readonly schemaVersion: 1; readonly name: string; readonly sourceSafety: "synthetic fixtures only" | "sanitized source-safe tasks"; readonly stages: Record<Exclude<CorpusMode, "regression">, StageRequirement>; readonly tasks: readonly CorpusTask[] }
