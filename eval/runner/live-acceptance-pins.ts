/**
 * These values are intentionally excluded from the source manifest.  Including
 * a file that contains its own digest would make the manifest circular.
 * `scripts/reproduce-live-fingerprints.mjs` computes the candidate values.
 */
export const expectedSourceFingerprint = "fd608befb5a432f97e64c362394660e4243767d2fd2c928d25f5fb8f99e84446";
export const expectedExtensionBuildFingerprint = "01ccfd9cf7a5fcd89ba039ec64bf2e768c8483ffdd95b84c45f40d360f8d079c";
