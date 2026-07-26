import type { EffortRouterConfig } from "./schema.js";

export const safeDefaults: Readonly<EffortRouterConfig> = {
  enabled: true,
  mode: "shadow",
  ambiguousEffort: "high",
  failureEffort: "xhigh",
  telemetry: { enabled: true, includePromptText: false, directory: ".pi/effort-router" },
  ui: { showStatus: true, notifyOnEscalation: false },
};
