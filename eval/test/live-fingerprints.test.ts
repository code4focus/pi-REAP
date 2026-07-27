import { describe, expect, it } from "vitest";
import { currentImplementationBinding, historicalV3CanaryBinding } from "../runner/live-acceptance-pins.js";
import { extensionBuildFingerprint, sourceManifestFingerprint } from "../runner/source-fingerprints.js";

describe("live acceptance fingerprint reproduction", () => {
  it("reproduces the pinned source and built-extension fingerprints from fixed manifests", () => {
    expect(sourceManifestFingerprint(process.cwd())).toBe(currentImplementationBinding.sourceFingerprint);
    expect(extensionBuildFingerprint(process.cwd())).toBe(currentImplementationBinding.extensionBuildFingerprint);
    expect(historicalV3CanaryBinding).toStrictEqual({ acceptedBaseSha256: "cbdbf256286ee7fb3d05e52ac7d702dfc0838ec6", sourceFingerprint: "fd608befb5a432f97e64c362394660e4243767d2fd2c928d25f5fb8f99e84446", extensionBuildFingerprint: "01ccfd9cf7a5fcd89ba039ec64bf2e768c8483ffdd95b84c45f40d360f8d079c" });
  });
});
