import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--dry-run")) throw new Error("Rollback validation is local-only. Use --dry-run; this command never mutates or publishes an artifact.");
const expectedRecordId = "synthetic-prior-artifact-record-v1";
const expectedBindingDigest = "377635d87dbe65f85ba67c621ca8b4f6d44fa9488efaf57d7b413ab5ca2b1411";
const expectedRecordDigest = "957383df7de96e2cbc83048647847877ade82cc69c6b24885ff9393f24aaa470";
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const configuredRoot = resolve(process.env.PI_REAP_ROLLBACK_ROOT ?? resolve(packageRoot, "test/fixtures/rollback"));
const digestPattern = /^[a-f0-9]{64}$/;
const fail = (message) => { throw new Error(`rollback contract failed: ${message}`); };
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value, keys, label) => {
  if (!record(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) fail(`${label} has unknown or missing fields`);
};
const canonical = (value) => value === null ? "null" : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : record(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const digest = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const string = (value, label) => { if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`); };
const sha256 = (value, label) => { if (typeof value !== "string" || !digestPattern.test(value)) fail(`${label} must be an exact SHA-256 digest`); };

if ((await lstat(configuredRoot)).isSymbolicLink()) fail("rollback fixture root must not be a symlink");
const root = await realpath(configuredRoot);
const contained = (path) => {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
async function load(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) fail(`${label} is not a regular file`);
  const actual = await realpath(path);
  if (!contained(actual)) fail(`${label} escapes its fixture root`);
  try { return JSON.parse(await readFile(actual, "utf8")); } catch { fail(`${label} is not valid JSON`); }
}

// The index is only a contained locator. It has no field capable of granting
// authority to changed record bytes or a recomputed internal binding.
const index = await load(resolve(root, "index.json"), "rollback index");
exact(index, ["format", "record"], "rollback index");
if (index.format !== 1 || index.record !== "prior-verified-artifact.json") fail("rollback index is unknown");
const artifactRecord = await load(resolve(root, index.record), "prior artifact record");
exact(artifactRecord, ["schemaVersion", "provenance", "recordId", "priorArtifactIdentity", "bindingDigest", "verification", "artifact"], "prior artifact record");
if (artifactRecord.schemaVersion !== 1 || artifactRecord.provenance !== "synthetic sanitized rollback fixture; not a real release artifact") fail("prior artifact record provenance is missing or not explicitly synthetic");
if (artifactRecord.recordId !== expectedRecordId) fail("prior artifact record is missing or replayed");
string(artifactRecord.priorArtifactIdentity, "prior artifact identity"); sha256(artifactRecord.bindingDigest, "combined binding digest");
exact(artifactRecord.verification, ["status", "verifiedAt", "verifier", "releaseSequence", "evidenceDigest"], "verification");
if (artifactRecord.verification.status !== "verified" || Number.isNaN(Date.parse(artifactRecord.verification.verifiedAt)) || artifactRecord.verification.releaseSequence !== 1) fail("prior artifact record is missing, unverified, or replayed");
string(artifactRecord.verification.verifier, "verifier"); sha256(artifactRecord.verification.evidenceDigest, "verification evidence");
exact(artifactRecord.artifact, ["identity", "binding"], "artifact");
exact(artifactRecord.artifact.identity, ["artifactId", "artifactDigest", "packageName", "packageVersion", "sourceFingerprint", "buildFingerprint"], "prior artifact identity binding");
for (const key of ["artifactId", "packageName", "packageVersion"]) string(artifactRecord.artifact.identity[key], `artifact ${key}`);
for (const key of ["artifactDigest", "sourceFingerprint", "buildFingerprint"]) sha256(artifactRecord.artifact.identity[key], `artifact ${key}`);
if (artifactRecord.artifact.identity.packageName !== "pi-reap" || artifactRecord.artifact.identity.packageVersion !== "0.9.0-synthetic") fail("prior package identity is incompatible");
const composedIdentity = `${artifactRecord.artifact.identity.packageName}@${artifactRecord.artifact.identity.packageVersion}#${artifactRecord.artifact.identity.artifactId}`;
if (artifactRecord.priorArtifactIdentity !== composedIdentity) fail("prior artifact identity binding is conflicted");
exact(artifactRecord.artifact.binding, ["capability", "admission", "match"], "combined profile binding");
const capability = artifactRecord.artifact.binding.capability; const admission = artifactRecord.artifact.binding.admission;
exact(capability, ["profileId", "profileRevision", "profileDigest", "source"], "capability profile binding");
exact(admission, ["profileId", "profileRevision", "profileDigest", "source", "capabilityProfileId", "capabilityProfileRevision"], "admission profile binding");
for (const [kind, identity] of [["capability", capability], ["admission", admission]]) {
  string(identity.profileId, `${kind} profile ID`); string(identity.profileRevision, `${kind} profile revision`); sha256(identity.profileDigest, `${kind} profile digest`);
  exact(identity.source, ["kind", "repositoryRevision"], `${kind} source`);
  if (identity.source.kind !== "repository-pinned") fail(`${kind} prior profile source was not verified`);
  string(identity.source.repositoryRevision, `${kind} repository revision`);
}
if (admission.capabilityProfileId !== capability.profileId || admission.capabilityProfileRevision !== capability.profileRevision) fail("admission capability reference is conflicted");
if (capability.source.repositoryRevision !== admission.source.repositoryRevision) fail("prior profile source bindings disagree");
const match = artifactRecord.artifact.binding.match;
exact(match, ["provider", "api", "model", "modelCatalogRevision", "modelCatalogDigest", "piPackage", "piVersion", "providerAdapterRevision", "providerAdapterDigest"], "profile match binding");
for (const key of ["provider", "api", "model", "modelCatalogRevision", "piPackage", "piVersion", "providerAdapterRevision"]) string(match[key], `match ${key}`);
sha256(match.modelCatalogDigest, "model catalog digest"); sha256(match.providerAdapterDigest, "provider adapter digest");
if (match.piPackage !== "@earendil-works/pi-coding-agent" || match.piVersion !== "0.82.1") fail("prior artifact Pi binding is incompatible");
const combinedBinding = { priorArtifactIdentity: artifactRecord.priorArtifactIdentity, artifact: artifactRecord.artifact };
if (digest(combinedBinding) !== artifactRecord.bindingDigest) fail("combined rollback binding digest is stale");
if (artifactRecord.bindingDigest !== expectedBindingDigest) fail("combined rollback binding is not authorized by the release contract");
if (digest(artifactRecord) !== expectedRecordDigest) fail("prior artifact record is not authorized by the release contract");
console.log(`rollback dry-run: verified exact ${expectedRecordId} binding ${expectedBindingDigest}; no settings, package, tag, or release state was changed`);
