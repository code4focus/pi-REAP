import { describe, expect, it } from "vitest";
import { expectedExtensionBuildFingerprint, expectedSourceFingerprint } from "../runner/live-acceptance-pins.js";
import { extensionBuildFingerprint, sourceManifestFingerprint } from "../runner/source-fingerprints.js";

describe("live acceptance fingerprint reproduction", () => {
  it("reproduces the pinned source and built-extension fingerprints from fixed manifests", () => {
    expect(sourceManifestFingerprint(process.cwd())).toBe(expectedSourceFingerprint);
    expect(extensionBuildFingerprint(process.cwd())).toBe(expectedExtensionBuildFingerprint);
  });
});
