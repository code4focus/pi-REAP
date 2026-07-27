import type { AutomaticEffort } from "../../src/domain/effort.js";
import type { TaskClass } from "../../src/domain/task-epoch.js";
import type { CorpusManifest, CorpusMode, CorpusTask } from "./types.js";

const allEfforts = ["low", "medium", "high", "xhigh"] as const;
const task = (id: string, mode: CorpusMode, taskClass: TaskClass, acceptedEfforts: readonly AutomaticEffort[], candidateEfforts: readonly AutomaticEffort[] = allEfforts): CorpusTask => ({ id, mode, taskClass, provenance: "synthetic", description: `Synthetic ${taskClass} evaluation fixture ${id}`, acceptedEfforts, candidateEfforts, grader: { kind: "exact", expected: `synthetic-${id}-answer` } });
const smokeClasses: readonly TaskClass[] = ["simple_query", "bounded_read", "implementation", "debugging", "architecture", "high_risk", "continuation", "unknown", "simple_query", "bounded_read", "implementation", "debugging"];
const smoke = smokeClasses.map((taskClass, index) => task(`smoke-${index + 1}`, "smoke", taskClass, index < 2 ? ["low", "medium", "high", "xhigh"] : index < 5 ? ["medium", "high", "xhigh"] : ["high", "xhigh"]));
const calibrationClasses: readonly TaskClass[] = ["simple_query", "bounded_read", "implementation", "debugging", "architecture", "high_risk", "continuation", "unknown", "simple_query", "bounded_read"];
const calibration = Array.from({ length: 30 }, (_, index) => { const taskClass = calibrationClasses[index % calibrationClasses.length]!; const candidates = taskClass === "simple_query" ? (["low", "medium", "high"] as const) : taskClass === "high_risk" ? (["high", "xhigh"] as const) : allEfforts; return task(`calibration-${index + 1}`, "calibration", taskClass, candidates, candidates); });
const regression = [
  task("regression-implementation", "regression", "implementation", ["high", "xhigh"]),
  task("regression-debugging", "regression", "debugging", ["high", "xhigh"]),
  task("regression-architecture", "regression", "architecture", ["xhigh"]),
  task("regression-high-risk", "regression", "high_risk", ["xhigh"]),
  task("regression-continuation", "regression", "continuation", ["high", "xhigh"]),
  { ...task("regression-under-routing-review", "regression", "simple_query", ["high", "xhigh"], ["low", "high", "xhigh"]), underRoutingFixture: true as const, nonCriticalRejection: true as const },
];

/** Deliberately synthetic representative tasks; no fixture represents a live Pi or provider run. */
export const syntheticManifest: CorpusManifest = { schemaVersion: 1, name: "synthetic-pr5-representative", sourceSafety: "synthetic fixtures only", stages: { smoke: { minimumTasks: 12, repetitions: 2, requiredCandidateEfforts: allEfforts }, calibration: { minimumTasks: 30, repetitions: 3 } }, tasks: [...smoke, ...calibration, ...regression] };
