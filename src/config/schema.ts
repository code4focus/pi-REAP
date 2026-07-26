import { Type, type Static } from "@sinclair/typebox";

export const ConfigurationSchema = Type.Object({
  enabled: Type.Boolean(),
  mode: Type.Union([Type.Literal("shadow"), Type.Literal("enforce")]),
  ambiguousEffort: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh")]),
  failureEffort: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh")]),
  telemetry: Type.Object({
    enabled: Type.Boolean(),
    includePromptText: Type.Boolean(),
    directory: Type.String(),
  }),
  ui: Type.Object({
    showStatus: Type.Boolean(),
    notifyOnEscalation: Type.Boolean(),
  }),
});

export type EffortRouterConfig = Static<typeof ConfigurationSchema>;
