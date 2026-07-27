/**
 * These values are intentionally excluded from the source manifest.  Including
 * a file that contains its own digest would make the manifest circular.
 * `scripts/reproduce-live-fingerprints.mjs` computes the candidate values.
 */
export const expectedSourceFingerprint = "a8ac44a5f828224bfa3e16ee4939e9cec9f2be4ae01e114b7388f0f775c2c76e";
export const expectedExtensionBuildFingerprint = "ef26ff8963be6c7532c59b97f7064e014b23b72c4e5b64c2a01e72e851ea4764";
