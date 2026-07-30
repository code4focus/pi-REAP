/** A binding is intentionally outside the runtime source manifest. */
export interface ImplementationBinding {
  readonly acceptedBaseSha256: string;
  readonly sourceFingerprint: string;
  readonly extensionBuildFingerprint: string;
}

/**
 * Immutable, normalized-only v3 canary metadata. It is historical evidence,
 * not a current promotion binding: its cache verdict is
 * OBSERVABILITY_UNAVAILABLE and it predates the corrected prerequisite base.
 */
export const historicalV3CanaryBinding: ImplementationBinding = Object.freeze({
  acceptedBaseSha256: "cbdbf256286ee7fb3d05e52ac7d702dfc0838ec6",
  sourceFingerprint: "fd608befb5a432f97e64c362394660e4243767d2fd2c928d25f5fb8f99e84446",
  extensionBuildFingerprint: "01ccfd9cf7a5fcd89ba039ec64bf2e768c8483ffdd95b84c45f40d360f8d079c",
});

/** Current corrected implementation binding, reproduced offline after build. */
export const currentImplementationBinding: ImplementationBinding = Object.freeze({
  acceptedBaseSha256: "53f312375293a80fa948c3fc8122fbc74471bc53",
  sourceFingerprint: "f622c6702d24d4c968e594c3c37ed48809033942fd65a6dd26a5a6ecd348a04e",
  extensionBuildFingerprint: "f63dab92da381f6c7ed6e14a51bdc1156368267912a21cee230673219a61bf0e",
});
