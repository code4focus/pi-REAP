import type { EffortRouterConfig } from "./schema.js";

export const safeDefaults: Readonly<EffortRouterConfig> = {
  enabled: true,
  mode: "shadow",
  ambiguousAnchor: "deliberate",
  failureAnchor: "exhaustive",
  telemetry: { enabled: true, includePromptText: false, directory: ".pi/effort-router" },
  ui: { showStatus: true, notifyOnEscalation: false },
};
