import type { AdmissionProfile, ReasoningCapabilityProfile, RungSelector } from "../../src/domain/profile.js";

export type CorpusMode = "smoke" | "calibration" | "regression";
export type FixtureProvenance = "synthetic" | "sanitized-captured";
export interface ProfileFixture {
  readonly name: string;
  readonly capability: ReasoningCapabilityProfile;
  readonly admission: AdmissionProfile;
  readonly provenance: FixtureProvenance;
}
/** Actual production activation boundary exercised by a fixture, never a routing hint. */
export interface RuntimeBoundaryVariant {
  readonly kind: "factory-activation" | "missing-activation" | "live-context-mismatch";
  readonly attestation?: Partial<Pick<ReasoningCapabilityProfile["match"], "modelCatalogRevision" | "modelCatalogDigest" | "piVersion" | "providerAdapterRevision" | "providerAdapterDigest">>;
  readonly model?: Partial<Pick<ReasoningCapabilityProfile["match"], "provider" | "api" | "model">>;
}
export interface CorpusTask {
  readonly id: string;
  readonly mode: CorpusMode;
  /** Oracle metadata only. Executors must not consult this field. */
  readonly taskClass: string;
  readonly provenance: FixtureProvenance;
  readonly description: string;
  readonly profile: ProfileFixture;
  /** Fail-closed corpus cases retain only the baseline arm. */
  readonly profileState?: "resolved" | "missing" | "unknown" | "revision-mismatch" | "candidate-capability" | "candidate-admission" | "conflict" | "reference-mismatch" | "attestation-mismatch";
  readonly boundary?: RuntimeBoundaryVariant;
  readonly requestedSelector?: RungSelector;
  readonly expectedOutput: string;
}
export interface StageRequirement { readonly minimumTasks: number; readonly repetitions: number }
export interface CorpusManifest {
  readonly schemaVersion: 2;
  readonly name: string;
  readonly sourceSafety: "synthetic fixtures only";
  readonly stages: Record<Exclude<CorpusMode, "regression">, StageRequirement>;
  readonly tasks: readonly CorpusTask[];
}
