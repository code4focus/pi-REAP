import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const SHA256 = /^[a-f0-9]{64}$/u;
const INITIAL_KEYS = ["simpleQuery", "boundedRead", "implementation", "debugging", "architecture", "highRisk", "continuation", "unknown"];
const EVIDENCE_KEYS = ["firstToolError", "repeatedToolError", "providerError", "lengthExhaustion", "overflowRetry", "failedContinuation"];
const ANCHOR_KEYS = ["economical", "balanced", "deliberate", "exhaustive"];
const MATCH_KEYS = ["provider", "api", "model", "modelCatalogRevision", "modelCatalogDigest", "piVersion", "providerAdapterRevision", "providerAdapterDigest"];
const RESERVED_COMMAND_TOKENS = new Set(["status", "auto", "shadow", "enforce", "prototype", ...Object.getOwnPropertyNames(Object.prototype)]);

export class ProfileRegistryContractError extends Error {
  constructor(message) { super(`profile contract failed: ${message}`); }
}

const fail = (message) => { throw new ProfileRegistryContractError(message); };
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const canonical = (value) => value === null ? "null" : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : record(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const digest = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const same = (left, right) => canonical(left) === canonical(right);
const exactKeys = (value, keys, label) => {
  if (!record(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) fail(`${label} has unknown or missing fields`);
};
const string = (value, label) => { if (typeof value !== "string" || value.trim().length === 0) fail(`${label} must be a non-empty string`); };
const sha256 = (value, label) => { if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} must be an exact SHA-256 digest`); };
const safeToken = (value) => typeof value === "string" && value.length > 0 && !/\s/u.test(value) && !RESERVED_COMMAND_TOKENS.has(value);

/**
 * The one authoritative decoder for a shipped registry. Both the operator CLI
 * and the production loader use this function; do not duplicate its checks.
 */
export async function readVerifiedProfileRegistry(configuredRoot) {
  const lexicalRoot = resolve(configuredRoot);
  if ((await lstat(lexicalRoot)).isSymbolicLink()) fail("profile root must not be a symlink");
  const root = await realpath(lexicalRoot);
  const contained = (path) => {
    const rel = relative(root, path);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  const loadContained = async (pathValue, directory, label) => {
    string(pathValue, `${label} path`);
    if (isAbsolute(pathValue) || pathValue.includes("\\") || pathValue.split("/").includes("..") || !pathValue.startsWith(`${directory}/`)) fail(`${label} has an uncontained source path`);
    const lexical = resolve(root, pathValue);
    if (!contained(lexical)) fail(`${label} has an uncontained source path`);
    const info = await lstat(lexical);
    if (info.isSymbolicLink() || !info.isFile()) fail(`${label} is not a contained regular file`);
    const actual = await realpath(lexical);
    if (!contained(actual)) fail(`${label} escapes the profile root after realpath`);
    try { return JSON.parse(await readFile(actual, "utf8")); } catch { fail(`${label} is not valid JSON`); }
  };
  const indexedFiles = async (directory) => {
    const path = resolve(root, directory);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory() || !contained(await realpath(path))) fail(`${directory} is not a contained profile directory`);
    const files = [];
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith(".json")) fail(`${directory}/${entry.name} is not an indexed regular JSON profile`);
      files.push(`${directory}/${entry.name}`);
    }
    return files.sort();
  };
  const registryPath = resolve(root, "index.json");
  const registryInfo = await lstat(registryPath);
  if (registryInfo.isSymbolicLink() || !registryInfo.isFile() || !contained(registryPath)) fail("registry is not a contained regular file");
  let registry;
  try { registry = JSON.parse(await readFile(await realpath(registryPath), "utf8")); } catch { fail("registry is not valid JSON"); }
  exactKeys(registry, ["format", "profiles"], "registry");
  if (registry.format !== 1 || !Array.isArray(registry.profiles) || registry.profiles.length === 0) fail("registry format is unknown");
  const seenIds = new Set(); const seenPaths = new Set(); const seenProfileIds = new Set(); const entries = [];
  for (const entry of registry.profiles) {
    exactKeys(entry, ["id", "state", "capability", "admission", "bindingDigest"], "registry entry");
    string(entry.id, "registry profile ID"); sha256(entry.bindingDigest, `${entry.id} binding digest`);
    if (!["candidate", "qualified", "pinned"].includes(entry.state)) fail(`${entry.id} has an unknown registry state`);
    if (seenIds.has(entry.id)) fail(`duplicate profile ID ${entry.id}`); seenIds.add(entry.id);
    exactKeys(entry.capability, ["path", "profileId", "profileRevision", "profileDigest", "source", "match"], `${entry.id} capability pin`);
    exactKeys(entry.admission, ["path", "profileId", "profileRevision", "profileDigest", "source", "capabilityProfileId", "capabilityProfileRevision"], `${entry.id} admission pin`);
    for (const pin of [entry.capability, entry.admission]) {
      string(pin.profileId, `${entry.id} pinned profile ID`); string(pin.profileRevision, `${entry.id} pinned revision`); sha256(pin.profileDigest, `${entry.id} pinned content digest`); validateSource(pin.source, `${entry.id} pin`, entry.state);
      if (seenPaths.has(pin.path)) fail(`duplicate profile path ${pin.path}`); seenPaths.add(pin.path);
      if (seenProfileIds.has(pin.profileId)) fail(`duplicate pinned profile identity ${pin.profileId}`); seenProfileIds.add(pin.profileId);
    }
    validateMatch(entry.capability.match, `${entry.id} pin`);
    const [capability, admission] = await Promise.all([loadContained(entry.capability.path, "capability", `${entry.id} capability`), loadContained(entry.admission.path, "admission", `${entry.id} admission`)]);
    const automatic = validateCapability(capability, `${entry.id} capability`, entry.state);
    validateAdmission(admission, `${entry.id} admission`, entry.state, automatic);
    if (digest(capability) !== entry.capability.profileDigest || digest(admission) !== entry.admission.profileDigest) fail(`${entry.id} content mutation does not match its pinned digest`);
    if (capability.profileId !== entry.id || capability.profileId !== entry.capability.profileId || capability.profileRevision !== entry.capability.profileRevision || admission.profileId !== entry.admission.profileId || admission.profileRevision !== entry.admission.profileRevision) fail(`${entry.id} has an identity conflict`);
    if (capability.profileRevision !== admission.profileRevision || admission.capabilityProfileId !== capability.profileId || admission.capabilityProfileRevision !== capability.profileRevision || admission.capabilityProfileId !== entry.admission.capabilityProfileId || admission.capabilityProfileRevision !== entry.admission.capabilityProfileRevision) fail(`${entry.id} has a stale or uncoordinated revision`);
    if (!same(capability.source, admission.source) || !same(capability.source, entry.capability.source) || !same(admission.source, entry.admission.source)) fail(`${entry.id} has a source disagreement`);
    if (!same(capability.match, entry.capability.match)) fail(`${entry.id} has a catalog, adapter, provider, API, Pi, or model mapping conflict`);
    const binding = { capability: { profileId: capability.profileId, profileRevision: capability.profileRevision, profileDigest: entry.capability.profileDigest }, admission: { profileId: admission.profileId, profileRevision: admission.profileRevision, profileDigest: entry.admission.profileDigest }, match: capability.match };
    if (digest(binding) !== entry.bindingDigest) fail(`${entry.id} binding digest is stale`);
    entries.push(Object.freeze({ id: entry.id, state: entry.state, capability, admission, binding, capabilityDigest: entry.capability.profileDigest, admissionDigest: entry.admission.profileDigest, bindingDigest: entry.bindingDigest, match: capability.match }));
  }
  const discovered = [...await indexedFiles("capability"), ...await indexedFiles("admission")].sort();
  if (discovered.length !== seenPaths.size || discovered.some((path) => !seenPaths.has(path))) fail("profile registry has unindexed or missing files");
  return Object.freeze({ root, entries: Object.freeze(entries) });
}

function validateSource(value, label, state) {
  if (state === "candidate") {
    if (record(value) && value.kind === "validated-catalog-candidate") { exactKeys(value, ["kind", "authority", "evidenceDigest"], `${label} source`); if (value.authority !== "candidate-only") fail(`${label} has unapproved source authority`); sha256(value.evidenceDigest, `${label} evidence digest`); return; }
    exactKeys(value, ["kind", "authority", "fixtureId"], `${label} source`);
    if (value.kind !== "synthetic-candidate" || value.authority !== "candidate-only") fail(`${label} has unapproved source authority`);
    string(value.fixtureId, `${label} synthetic fixture ID`); return;
  }
  if (state === "qualified") {
    exactKeys(value, ["kind", "approvalDigest"], `${label} source`);
    if (value.kind !== "user-approved-local") fail(`${label} qualified source requires explicit local approval`);
    sha256(value.approvalDigest, `${label} approval digest`); return;
  }
  exactKeys(value, ["kind", "repositoryRevision"], `${label} source`);
  if (value.kind !== "repository-pinned") fail(`${label} pinned source requires repository pinning`);
  string(value.repositoryRevision, `${label} repository revision`);
}
function validateMatch(value, label) {
  exactKeys(value, MATCH_KEYS, `${label} match`);
  for (const key of MATCH_KEYS) string(value[key], `${label} match ${key}`);
  sha256(value.modelCatalogDigest, `${label} catalog digest`); sha256(value.providerAdapterDigest, `${label} adapter digest`);
  if (value.piVersion !== "0.82.1") fail(`${label} has stale or invalid Pi identity`);
}
function selector(value, label, automatic) {
  if (!record(value) || typeof value.kind !== "string") fail(`${label} selector is invalid`);
  if (value.kind === "anchor") {
    exactKeys(value, ["kind", "name"], `${label} selector`);
    if (!ANCHOR_KEYS.includes(value.name) || !automatic.anchors.has(value.name)) fail(`${label} anchor is unknown or infeasible`);
    return;
  }
  exactKeys(value, ["kind"], `${label} selector`);
  if (!["lowest-automatic", "next-above-lowest", "next-below-ceiling", "automatic-ceiling"].includes(value.kind)) fail(`${label} selector is unknown`);
  if ((value.kind === "next-above-lowest" || value.kind === "next-below-ceiling") && automatic.rungs.length < 2) fail(`${label} selector is infeasible`);
}
function validateCapability(value, label, state) {
  const keys = ["schemaVersion", "profileId", "profileRevision", "source", "match", "rungs", "automaticFloor", "automaticCeiling", "anchors", "baselineBehavior"];
  if (record(value) && "explicitCeiling" in value) keys.push("explicitCeiling");
  exactKeys(value, keys, label);
  if (value.schemaVersion !== 1) fail(`${label} schema is unknown`);
  string(value.profileId, `${label} ID`); string(value.profileRevision, `${label} revision`); validateSource(value.source, label, state); validateMatch(value.match, label);
  if (!Array.isArray(value.rungs) || value.rungs.length < 2) fail(`${label} requires at least two rungs`);
  const ids = new Set(); const aliases = new Set(); const rungs = [];
  for (const [ordinal, rung] of value.rungs.entries()) {
    const rungKeys = ["id", "ordinal", "providerValue", "automaticEligible", "explicitOnly"];
    if (record(rung) && "aliases" in rung) rungKeys.push("aliases");
    exactKeys(rung, rungKeys, `${label} rung`); string(rung.id, `${label} rung ID`);
    if (ids.has(rung.id) || aliases.has(rung.id) || rung.ordinal !== ordinal || !Number.isSafeInteger(rung.ordinal) || typeof rung.providerValue !== "string" || typeof rung.automaticEligible !== "boolean" || typeof rung.explicitOnly !== "boolean" || rung.automaticEligible === rung.explicitOnly) fail(`${label} has duplicate, stale, or conflicted rung mapping`);
    if ("aliases" in rung && (!Array.isArray(rung.aliases) || rung.aliases.some((alias) => typeof alias !== "string" || !alias || ids.has(alias) || aliases.has(alias) || alias === rung.id))) fail(`${label} rung aliases are invalid`);
    ids.add(rung.id); for (const alias of rung.aliases ?? []) aliases.add(alias); rungs.push(rung);
  }
  exactKeys(value.anchors, ANCHOR_KEYS, `${label} anchors`);
  const byId = new Map(rungs.map((rung) => [rung.id, rung])); const floor = byId.get(value.automaticFloor); const ceiling = byId.get(value.automaticCeiling); const explicit = value.explicitCeiling === undefined ? undefined : byId.get(value.explicitCeiling);
  if (!floor?.automaticEligible || !ceiling?.automaticEligible || floor.ordinal > ceiling.ordinal || (value.explicitCeiling !== undefined && (!explicit?.explicitOnly || explicit.automaticEligible || explicit.ordinal < ceiling.ordinal)) || (value.explicitCeiling === undefined && rungs.some((rung) => rung.explicitOnly))) fail(`${label} has a stale rung binding`);
  if (rungs.some((rung) => rung.automaticEligible && (rung.ordinal < floor.ordinal || rung.ordinal > ceiling.ordinal)) || rungs.some((rung) => rung.explicitOnly && rung.ordinal < ceiling.ordinal)) fail(`${label} has a stale rung binding`);
  const automatic = rungs.filter((rung) => rung.automaticEligible && rung.ordinal >= floor.ordinal && rung.ordinal <= ceiling.ordinal);
  const anchors = new Map(); let previousAnchor = -1;
  for (const anchor of ANCHOR_KEYS) { const rung = byId.get(value.anchors[anchor]); if (!rung?.automaticEligible || rung.ordinal < floor.ordinal || rung.ordinal > ceiling.ordinal || rung.ordinal < previousAnchor) fail(`${label} has a stale rung binding`); anchors.set(anchor, rung); previousAnchor = rung.ordinal; }
  const manualCeiling = explicit ?? ceiling;
  if (rungs.some((rung) => rung.ordinal <= manualCeiling.ordinal && (!safeToken(rung.id) || (rung.aliases ?? []).some((alias) => !safeToken(alias))))) fail(`${label} has unsafe manual rung tokens`);
  if (value.baselineBehavior !== "preserve-request") fail(`${label} must preserve baseline`);
  return { rungs: automatic, anchors };
}
function validateAdmission(value, label, state, capability) {
  exactKeys(value, ["schemaVersion", "profileId", "profileRevision", "source", "capabilityProfileId", "capabilityProfileRevision", "initial", "evidence"], label);
  if (value.schemaVersion !== 1) fail(`${label} schema is unknown`);
  string(value.profileId, `${label} ID`); string(value.profileRevision, `${label} revision`); string(value.capabilityProfileId, `${label} capability ID`); string(value.capabilityProfileRevision, `${label} capability revision`); validateSource(value.source, label, state);
  exactKeys(value.initial, INITIAL_KEYS, `${label} initial routes`); for (const key of INITIAL_KEYS) selector(value.initial[key], `${label} ${key}`, capability);
  exactKeys(value.evidence, EVIDENCE_KEYS, `${label} evidence routes`); for (const key of EVIDENCE_KEYS) { exactKeys(value.evidence[key], ["selector"], `${label} ${key}`); selector(value.evidence[key].selector, `${label} ${key}`, capability); }
}
