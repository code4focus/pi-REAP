/** A binding is intentionally outside the runtime source manifest. */
export interface ImplementationBinding {
  readonly acceptedBaseSha256: string;
  readonly sourceFingerprint: string;
  readonly extensionBuildFingerprint: string;
}

/**
 * Immutable, normalized-only v3 canary metadata. It is historical evidence,
 * not a current promotion binding: its cache verdict is OBSERVABILITY_UNAVAILABLE.
 */
export const historicalV3CanaryBinding: ImplementationBinding = Object.freeze({
  acceptedBaseSha256: "cbdbf256286ee7fb3d05e52ac7d702dfc0838ec6",
  sourceFingerprint: "fd608befb5a432f97e64c362394660e4243767d2fd2c928d25f5fb8f99e84446",
  extensionBuildFingerprint: "01ccfd9cf7a5fcd89ba039ec64bf2e768c8483ffdd95b84c45f40d360f8d079c",
});

/** Current corrected implementation binding, reproduced offline after build. */
export const currentImplementationBinding: ImplementationBinding = Object.freeze({
  acceptedBaseSha256: "905a067f145a61cdf7203718a8e09b400952463a",
  sourceFingerprint: "e87ffe3fbbeec2125ae33aedad1d1687df1efae0722f3e3b5e55da5edf373bf9",
  extensionBuildFingerprint: "cb737689cb098b80f17f9fe6640427c797bc3c5e558a86e7684eb0fc8704127d",
});
