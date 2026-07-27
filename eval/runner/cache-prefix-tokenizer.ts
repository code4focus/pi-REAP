import { createHash } from "node:crypto";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

export const cachePrefixTokenizerName = "o200k_base";
export const cachePrefixTokenizerPackage = "js-tiktoken";
export const cachePrefixTokenizerVersion = "1.0.21";
export const cachePrefixTokenizerPackageIntegrity = "sha512-biOj/6M5qdgx5TKjDnFT1ymSpM5tbd3ylwDtrQvFQSu0Z7bBYko2dF+W/aUkXUPuk6IVpRxk/3Q2sHOzGlS36g==";
export const cachePrefixBase64Version = "1.5.1";
export const cachePrefixBase64PackageIntegrity = "sha512-AKpaYlHn8t4SVbOHCy+b5+KKgvR4vrsD8vbvrbiQJps7fKDTkjkDry6ji0rUJjC0kzbNePLwzxq8iypo41qeWA==";
export const officialO200kBaseRanksSha256 = "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d";
const expectedPatternSha256 = "6f88fcc3dd53c515d0835648c274a7df6e686598d0f3d4981319b524ed55ddd2";
const expectedSpecialTokensSha256 = "94c390bc2638a0888b4ce311255bb8ba2c1f8240037ea4a6ad069bdde7e7ee04";
const expectedRankCount = 199_998;
const implementationVectors = [
  ["hello world", [24_912, 2_375]],
  ["tiktoken is great!", [83, 8_251, 2_488, 382, 2_212, 0]],
] as const;
let verifiedTokenizer: Tiktoken | undefined;
let verifiedTokenizerFingerprint: string | undefined;

export interface OfflineTokenizerMeasurement {
  readonly commonPrefixSha256: string;
  readonly tokenCount: number;
  readonly tokenizerName: typeof cachePrefixTokenizerName;
  readonly tokenizerFingerprint: string;
}

/**
 * Counts only the exact source-owned system-content boundary common to all
 * cache calls. The private task begins after this boundary and is never
 * retained here. All encoding data ships in the integrity-pinned dependency.
 */
export function measureOfflineCachePrefix(commonPrefix: string): OfflineTokenizerMeasurement {
  if (typeof commonPrefix !== "string" || commonPrefix.length === 0) throw new Error("cache prefix boundary is invalid");
  const { tokenizer, tokenizerFingerprint } = loadVerifiedTokenizer();
  return Object.freeze({
    commonPrefixSha256: sha256(commonPrefix),
    tokenCount: tokenizer.encode(commonPrefix).length,
    tokenizerName: cachePrefixTokenizerName,
    tokenizerFingerprint,
  });
}

function loadVerifiedTokenizer(): { readonly tokenizer: Tiktoken; readonly tokenizerFingerprint: string } {
  if (verifiedTokenizer && verifiedTokenizerFingerprint) {
    return { tokenizer: verifiedTokenizer, tokenizerFingerprint: verifiedTokenizerFingerprint };
  }
  const officialRanksSha256 = reconstructedOfficialRanksSha256();
  if (officialRanksSha256 !== officialO200kBaseRanksSha256) throw new Error("bundled o200k_base ranks do not match the official OpenAI fingerprint");
  if (sha256(o200kBase.pat_str) !== expectedPatternSha256 ||
    sha256(canonicalJson(o200kBase.special_tokens)) !== expectedSpecialTokensSha256) {
    throw new Error("bundled o200k_base metadata does not match the pinned encoding");
  }

  const tokenizer = new Tiktoken(o200kBase);
  for (const [text, expected] of implementationVectors) {
    if (canonicalJson(tokenizer.encode(text)) !== canonicalJson(expected)) throw new Error("offline tokenizer failed a pinned o200k_base vector");
  }
  const tokenizerFingerprint = sha256(canonicalJson({
    base64Implementation: "base64-js",
    base64ImplementationVersion: cachePrefixBase64Version,
    base64PackageIntegrity: cachePrefixBase64PackageIntegrity,
    implementation: cachePrefixTokenizerPackage,
    implementationVersion: cachePrefixTokenizerVersion,
    officialRanksSha256,
    packageIntegrity: cachePrefixTokenizerPackageIntegrity,
    patternSha256: expectedPatternSha256,
    specialTokensSha256: expectedSpecialTokensSha256,
    tokenizerName: cachePrefixTokenizerName,
  }));
  verifiedTokenizer = tokenizer;
  verifiedTokenizerFingerprint = tokenizerFingerprint;
  return { tokenizer, tokenizerFingerprint };
}

/** Recreates the canonical `.tiktoken` byte stream hashed by OpenAI. */
export function reconstructedOfficialRanksSha256(): string {
  const lines: string[] = [];
  let expectedOffset = 0;
  for (const compressedLine of o200kBase.bpe_ranks.split("\n").filter(Boolean)) {
    const [_marker, offsetText, ...tokens] = compressedLine.split(" ");
    const offset = Number.parseInt(offsetText ?? "", 10);
    if (!Number.isInteger(offset) || offset !== expectedOffset || tokens.length === 0) throw new Error("bundled o200k_base rank compression is invalid");
    for (const token of tokens) {
      if (Buffer.from(token, "base64").toString("base64") !== token) throw new Error("bundled o200k_base rank token is invalid");
      lines.push(`${token} ${expectedOffset}`);
      expectedOffset += 1;
    }
  }
  if (expectedOffset !== expectedRankCount) throw new Error("bundled o200k_base rank count is invalid");
  return sha256(Buffer.from(`${lines.join("\n")}\n`));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) throw new Error("undefined is not canonical JSON");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
