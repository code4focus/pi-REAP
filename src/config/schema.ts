import { Type, type Static } from "@sinclair/typebox";

export const ConfigurationSchema = Type.Object({
  enabled: Type.Boolean(),
  mode: Type.Union([Type.Literal("shadow"), Type.Literal("enforce")]),
  ambiguousAnchor: Type.Union([Type.Literal("economical"), Type.Literal("balanced"), Type.Literal("deliberate"), Type.Literal("exhaustive")]),
  failureAnchor: Type.Union([Type.Literal("economical"), Type.Literal("balanced"), Type.Literal("deliberate"), Type.Literal("exhaustive")]),
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
