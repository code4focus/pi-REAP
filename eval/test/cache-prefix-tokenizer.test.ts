import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cachePrefixBase64PackageIntegrity,
  cachePrefixBase64Version,
  cachePrefixTokenizerName,
  cachePrefixTokenizerPackageIntegrity,
  cachePrefixTokenizerVersion,
  measureOfflineCachePrefix,
  officialO200kBaseRanksSha256,
  reconstructedOfficialRanksSha256,
} from "../runner/cache-prefix-tokenizer.js";
import {
  cacheEvaluationSystemPrompt,
  exactCachePrefixMeasurement,
  requireExactCachePrefixMeasurement,
  sha256,
  type ExactCachePrefixMeasurement,
} from "../runner/live-driver.js";

afterEach(() => vi.unstubAllGlobals());

describe("offline provider-compatible cache-prefix tokenizer", () => {
  it("reconstructs OpenAI's authoritative o200k_base rank fingerprint", () => {
    expect(reconstructedOfficialRanksSha256()).toBe(officialO200kBaseRanksSha256);
    expect(officialO200kBaseRanksSha256).toBe("446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d");
    expect(cachePrefixTokenizerName).toBe("o200k_base");
    expect(cachePrefixTokenizerVersion).toBe("1.0.21");
  });

  it("measures the exact common system-content boundary without network access or retained text", () => {
    const network = vi.fn(() => { throw new Error("network access is forbidden"); });
    vi.stubGlobal("fetch", network);
    const measurement = measureOfflineCachePrefix(cacheEvaluationSystemPrompt);
    expect(network).not.toHaveBeenCalled();
    expect(measurement).toStrictEqual({
      commonPrefixSha256: "e578aed13602cfc7ef597920087483eed15671325d36849b5a5c22e23344c471",
      tokenCount: 1_112,
      tokenizerName: "o200k_base",
      tokenizerFingerprint: "fc2139538d73fe447c400bebed90e1397c0ffe1a7487660497697b201b1b69e3",
    });
    expect(JSON.stringify(measurement)).not.toContain(cacheEvaluationSystemPrompt);
  });

  it("pins package integrity and rejects wrong encoding, fingerprint, count, or prefix boundary", () => {
    const lock = readFileSync("pnpm-lock.yaml", "utf8");
    expect(lock).toContain(`js-tiktoken@${cachePrefixTokenizerVersion}:`);
    expect(lock).toContain(`integrity: ${cachePrefixTokenizerPackageIntegrity}`);
    expect(lock).toContain(`base64-js@${cachePrefixBase64Version}:`);
    expect(lock).toContain(`integrity: ${cachePrefixBase64PackageIntegrity}`);

    const exact = exactCachePrefixMeasurement();
    const attacks: ExactCachePrefixMeasurement[] = [
      { ...exact, tokenizerName: "cl100k_base" } as unknown as ExactCachePrefixMeasurement,
      { ...exact, tokenizerFingerprint: sha256("wrong-tokenizer") },
      { ...exact, tokenCount: exact.tokenCount + 1 },
      { ...exact, commonPrefixSha256: sha256(`${cacheEvaluationSystemPrompt}\nprivate-boundary-canary`) },
    ];
    for (const attack of attacks) expect(() => requireExactCachePrefixMeasurement(attack)).toThrow();
    expect(requireExactCachePrefixMeasurement(exact)).toStrictEqual(exact);
  });
});
