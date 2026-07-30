import type { ReasonCode, RoutingFeatures } from "../domain/routing-decision.js";
import type { TaskClass } from "../domain/task-epoch.js";
export interface ClassificationInput { features: RoutingFeatures; relation: "new" | "continuation" | "ambiguous"; previousFailed: boolean; resumeGuard: boolean }
export interface Classification { taskClass: TaskClass; confidence: "high" | "medium" | "low"; reasons: ReasonCode[] }
const yes = (f: RoutingFeatures, n: string) => f[n] === true;
/** Deterministic semantic classification. Admission selectors, never provider labels, choose rungs. */
export function classify(input: ClassificationInput): Classification {
  const { features, relation } = input;
  if ((input.resumeGuard && relation !== "new") || input.previousFailed || yes(features, "highRisk") || yes(features, "longRunningGoal")) return { taskClass: input.previousFailed || relation !== "new" ? "continuation" : yes(features, "longRunningGoal") ? "architecture" : "high_risk", confidence: "high", reasons: [input.previousFailed ? "PREVIOUS_EPOCH_FAILED" : input.resumeGuard && relation !== "new" ? "RESUMED_SESSION_AMBIGUOUS" : yes(features, "longRunningGoal") ? "MULTI_STAGE_TASK" : "HIGH_RISK_DOMAIN"] };
  if (yes(features, "codeChange") || yes(features, "testsRequested") || yes(features, "multiStage")) return { taskClass: yes(features, "codeChange") ? "implementation" : "architecture", confidence: "high", reasons: [yes(features, "codeChange") ? "CODE_CHANGE_REQUESTED" : "MULTI_STAGE_TASK"] };
  if (relation !== "new" || yes(features, "continuationSignal") || yes(features, "streamingContinuation")) return { taskClass: "continuation", confidence: "medium", reasons: ["CONTINUATION_REFERENCE"] };
  if (yes(features, "boundedRead")) return { taskClass: "bounded_read", confidence: "high", reasons: ["BOUNDED_READ_ONLY"] };
  if (yes(features, "simpleQuestion") && yes(features, "shortPrompt")) return { taskClass: "simple_query", confidence: "high", reasons: ["EXPLICIT_SIMPLE_QUERY"] };
  return { taskClass: "unknown", confidence: "low", reasons: ["AMBIGUOUS_CONSERVATIVE_DEFAULT"] };
}
