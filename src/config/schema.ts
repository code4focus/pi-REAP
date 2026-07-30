import { Type, type Static } from "@sinclair/typebox";

export const ConfigurationSchema = Type.Object({
  enabled: Type.Boolean(),
  mode: Type.Union([Type.Literal("shadow"), Type.Literal("enforce")]),
  /** Exact read-only profile selection.  Absence intentionally means baseline. */
  profileActivation: Type.Optional(Type.Object({
    registryId: Type.String({ minLength: 1 }),
    bindingDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  }, { additionalProperties: false })),
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
