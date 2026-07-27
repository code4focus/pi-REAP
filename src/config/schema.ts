import { Type, type Static } from "@sinclair/typebox";

export const ConfigurationSchema = Type.Object({
  enabled: Type.Boolean(),
  mode: Type.Union([Type.Literal("shadow"), Type.Literal("enforce")]),
  telemetry: Type.Object({
    enabled: Type.Boolean(),
    includePromptText: Type.Boolean(),
    directory: Type.String(),
  }, { additionalProperties: false }),
  ui: Type.Object({
    showStatus: Type.Boolean(),
    notifyOnEscalation: Type.Boolean(),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export type EffortRouterConfig = Static<typeof ConfigurationSchema>;
