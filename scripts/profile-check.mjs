import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const configuredRoot = resolve(process.env.PI_REAP_PROFILES_ROOT ?? resolve(packageRoot, "profiles"));
const sha256Pattern = /^[a-f0-9]{64}$/;
const initialKeys = ["simpleQuery", "boundedRead", "implementation", "debugging", "architecture", "highRisk", "continuation", "unknown"];
const evidenceKeys = ["firstToolError", "repeatedToolError", "providerError", "lengthExhaustion", "overflowRetry", "failedContinuation"];
const anchorKeys = ["economical", "balanced", "deliberate", "exhaustive"];
const matchKeys = ["provider", "api", "model", "modelCatalogRevision", "modelCatalogDigest", "piVersion", "providerAdapterRevision", "providerAdapterDigest"];
const fail = (message) => { throw new Error(`profile contract failed: ${message}`); };
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const canonical = (value) => value === null ? "null" : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : record(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const digest = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const same = (left, right) => canonical(left) === canonical(right);
const exactKeys = (value, keys, label) => {
  if (!record(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) fail(`${label} has unknown or missing fields`);
};
const string = (value, label) => { if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`); };
const sha256 = (value, label) => { if (typeof value !== "string" || !sha256Pattern.test(value)) fail(`${label} must be an exact SHA-256 digest`); };

if ((await lstat(configuredRoot)).isSymbolicLink()) fail("profile root must not be a symlink");
const profilesRoot = await realpath(configuredRoot);
const contained = (path) => {
  const rel = relative(profilesRoot, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
};
async function loadContained(pathValue, directory, label) {
  string(pathValue, `${label} path`);
  if (isAbsolute(pathValue) || pathValue.includes("\\") || pathValue.split("/").includes("..") || !pathValue.startsWith(`${directory}/`)) fail(`${label} has an uncontained source path`);
  const lexical = resolve(profilesRoot, pathValue);
  if (!contained(lexical)) fail(`${label} has an uncontained source path`);
  const info = await lstat(lexical);
  if (info.isSymbolicLink() || !info.isFile()) fail(`${label} is not a contained regular file`);
  const actual = await realpath(lexical);
  if (!contained(actual)) fail(`${label} escapes the profile root after realpath`);
  try { return JSON.parse(await readFile(actual, "utf8")); } catch { fail(`${label} is not valid JSON`); }
}
async function indexedFiles(directory) {
  const path = resolve(profilesRoot, directory);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || !contained(await realpath(path))) fail(`${directory} is not a contained profile directory`);
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith(".json")) fail(`${directory}/${entry.name} is not an indexed regular JSON profile`);
    files.push(`${directory}/${entry.name}`);
  }
  return files.sort();
}
function validateSource(value, label) {
  exactKeys(value, ["kind", "authority", "evidenceDigest"], `${label} source`);
  if (value.kind !== "validated-catalog-candidate" || value.authority !== "candidate-only") fail(`${label} has unapproved source authority`);
  sha256(value.evidenceDigest, `${label} evidence digest`);
}
function validateMatch(value, label) {
  exactKeys(value, matchKeys, `${label} match`);
  for (const key of matchKeys) string(value[key], `${label} match ${key}`);
  sha256(value.modelCatalogDigest, `${label} catalog digest`);
  sha256(value.providerAdapterDigest, `${label} adapter digest`);
  if (value.piVersion !== "0.82.1") fail(`${label} has stale or invalid Pi identity`);
}
function validateSelector(value, label) {
  if (!record(value) || typeof value.kind !== "string") fail(`${label} selector is invalid`);
  if (value.kind === "anchor") {
    exactKeys(value, ["kind", "name"], `${label} selector`);
    if (!anchorKeys.includes(value.name)) fail(`${label} anchor is unknown`);
  } else {
    exactKeys(value, ["kind"], `${label} selector`);
    if (!["lowest-automatic", "next-above-lowest", "next-below-ceiling", "automatic-ceiling"].includes(value.kind)) fail(`${label} selector is unknown`);
  }
}
function validateCapability(value, label) {
  const keys = ["schemaVersion", "profileId", "profileRevision", "source", "match", "rungs", "automaticFloor", "automaticCeiling", "anchors", "baselineBehavior"];
  if (record(value) && "explicitCeiling" in value) keys.push("explicitCeiling");
  exactKeys(value, keys, label);
  if (value.schemaVersion !== 1) fail(`${label} schema is unknown`);
  string(value.profileId, `${label} ID`); string(value.profileRevision, `${label} revision`);
  validateSource(value.source, label); validateMatch(value.match, label);
  if (!Array.isArray(value.rungs) || value.rungs.length < 2) fail(`${label} requires at least two rungs`);
  const ids = new Set();
  for (const [ordinal, rung] of value.rungs.entries()) {
    const rungKeys = ["id", "ordinal", "providerValue", "automaticEligible", "explicitOnly"];
    if (record(rung) && "aliases" in rung) rungKeys.push("aliases");
    exactKeys(rung, rungKeys, `${label} rung`);
    string(rung.id, `${label} rung ID`);
    if (ids.has(rung.id) || rung.ordinal !== ordinal || typeof rung.providerValue !== "string" || typeof rung.automaticEligible !== "boolean" || typeof rung.explicitOnly !== "boolean" || rung.automaticEligible === rung.explicitOnly) fail(`${label} has duplicate, stale, or conflicted rung mapping`);
    ids.add(rung.id);
    if ("aliases" in rung && (!Array.isArray(rung.aliases) || rung.aliases.some((alias) => typeof alias !== "string"))) fail(`${label} rung aliases are invalid`);
  }
  exactKeys(value.anchors, anchorKeys, `${label} anchors`);
  if (Object.values(value.anchors).some((id) => !ids.has(id)) || !ids.has(value.automaticFloor) || !ids.has(value.automaticCeiling) || ("explicitCeiling" in value && !ids.has(value.explicitCeiling))) fail(`${label} has a stale rung binding`);
  if (value.baselineBehavior !== "preserve-request") fail(`${label} must preserve baseline`);
}
function validateAdmission(value, label) {
  exactKeys(value, ["schemaVersion", "profileId", "profileRevision", "source", "capabilityProfileId", "capabilityProfileRevision", "initial", "evidence"], label);
  if (value.schemaVersion !== 1) fail(`${label} schema is unknown`);
  string(value.profileId, `${label} ID`); string(value.profileRevision, `${label} revision`);
  string(value.capabilityProfileId, `${label} capability ID`); string(value.capabilityProfileRevision, `${label} capability revision`);
  validateSource(value.source, label);
  exactKeys(value.initial, initialKeys, `${label} initial routes`);
  for (const key of initialKeys) validateSelector(value.initial[key], `${label} ${key}`);
  exactKeys(value.evidence, evidenceKeys, `${label} evidence routes`);
  for (const key of evidenceKeys) { exactKeys(value.evidence[key], ["selector"], `${label} ${key}`); validateSelector(value.evidence[key].selector, `${label} ${key}`); }
}

const registryPath = resolve(profilesRoot, "index.json");
const registryInfo = await lstat(registryPath);
if (registryInfo.isSymbolicLink() || !registryInfo.isFile() || !contained(registryPath)) fail("registry is not a contained regular file");
const registry = JSON.parse(await readFile(await realpath(registryPath), "utf8"));
exactKeys(registry, ["format", "profiles"], "registry");
if (registry.format !== 1 || !Array.isArray(registry.profiles) || registry.profiles.length === 0) fail("registry format is unknown");
const seenIds = new Set(); const seenPaths = new Set(); const seenProfileIds = new Set(); const checked = [];
for (const entry of registry.profiles) {
  exactKeys(entry, ["id", "state", "capability", "admission", "bindingDigest"], "registry entry");
  string(entry.id, "registry profile ID"); sha256(entry.bindingDigest, `${entry.id} binding digest`);
  if (entry.state !== "candidate") fail(`${entry.id} is not candidate-only`);
  if (seenIds.has(entry.id)) fail(`duplicate profile ID ${entry.id}`); seenIds.add(entry.id);
  exactKeys(entry.capability, ["path", "profileId", "profileRevision", "profileDigest", "source", "match"], `${entry.id} capability pin`);
  exactKeys(entry.admission, ["path", "profileId", "profileRevision", "profileDigest", "source", "capabilityProfileId", "capabilityProfileRevision"], `${entry.id} admission pin`);
  for (const pin of [entry.capability, entry.admission]) {
    string(pin.profileId, `${entry.id} pinned profile ID`); string(pin.profileRevision, `${entry.id} pinned revision`); sha256(pin.profileDigest, `${entry.id} pinned content digest`); validateSource(pin.source, `${entry.id} pin`);
    if (seenPaths.has(pin.path)) fail(`duplicate profile path ${pin.path}`); seenPaths.add(pin.path);
    if (seenProfileIds.has(pin.profileId)) fail(`duplicate pinned profile identity ${pin.profileId}`); seenProfileIds.add(pin.profileId);
  }
  validateMatch(entry.capability.match, `${entry.id} pin`);
  const [capability, admission] = await Promise.all([loadContained(entry.capability.path, "capability", `${entry.id} capability`), loadContained(entry.admission.path, "admission", `${entry.id} admission`)]);
  validateCapability(capability, `${entry.id} capability`); validateAdmission(admission, `${entry.id} admission`);
  if (digest(capability) !== entry.capability.profileDigest || digest(admission) !== entry.admission.profileDigest) fail(`${entry.id} content mutation does not match its pinned digest`);
  if (capability.profileId !== entry.id || capability.profileId !== entry.capability.profileId || capability.profileRevision !== entry.capability.profileRevision || admission.profileId !== entry.admission.profileId || admission.profileRevision !== entry.admission.profileRevision) fail(`${entry.id} has an identity conflict`);
  if (capability.profileRevision !== admission.profileRevision || admission.capabilityProfileId !== capability.profileId || admission.capabilityProfileRevision !== capability.profileRevision || admission.capabilityProfileId !== entry.admission.capabilityProfileId || admission.capabilityProfileRevision !== entry.admission.capabilityProfileRevision) fail(`${entry.id} has a stale or uncoordinated revision`);
  if (!same(capability.source, admission.source) || !same(capability.source, entry.capability.source) || !same(admission.source, entry.admission.source)) fail(`${entry.id} has a source disagreement`);
  if (!same(capability.match, entry.capability.match)) fail(`${entry.id} has a catalog, adapter, provider, API, Pi, or model mapping conflict`);
  const binding = { capability: { profileId: capability.profileId, profileRevision: capability.profileRevision, profileDigest: entry.capability.profileDigest }, admission: { profileId: admission.profileId, profileRevision: admission.profileRevision, profileDigest: entry.admission.profileDigest }, match: capability.match };
  if (digest(binding) !== entry.bindingDigest) fail(`${entry.id} binding digest is stale`);
  checked.push({ id: entry.id, capabilityDigest: entry.capability.profileDigest, admissionDigest: entry.admission.profileDigest, bindingDigest: entry.bindingDigest, state: entry.state, match: capability.match });
}
const discovered = [...await indexedFiles("capability"), ...await indexedFiles("admission")].sort();
if (discovered.length !== seenPaths.size || discovered.some((path) => !seenPaths.has(path))) fail("profile registry has unindexed or missing files");

const arg = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
if (process.argv.includes("--list")) for (const profile of checked) console.log(`${profile.id} ${profile.state} ${profile.capabilityDigest} ${profile.admissionDigest} ${profile.bindingDigest}`);
if (process.argv.includes("--check")) {
  const id = arg("--id"); const profile = checked.find((candidate) => candidate.id === id);
  if (!id || !profile) fail("unknown profile identity preserves baseline");
  console.log(`${profile.id}: candidate only; qualification and human approval are required before pinning; preserve-baseline`);
}
if (!process.argv.includes("--list") && !process.argv.includes("--check")) console.log(`profile verification passed: ${checked.length} candidate profile(s), no profile is pinned or enforcement-authorized`);
