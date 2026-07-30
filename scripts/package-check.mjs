import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  expectedPiCatalogSha256,
  expectedPiExecutableSha256,
  expectedPiRuntimeGraphSha256,
  expectedPiVersion,
  resolveStrictPiGraph,
} from "../dist/distribution/pi-graph-contract.js";

if (!process.argv.includes("--dry-run")) throw new Error("Package verification is local-only. Use --dry-run; this command does not publish.");
const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const fail = (message) => { throw new Error(`package contract failed: ${message}`); };
const expectedFiles = ["dist", "src", "profiles", "scripts/profile-check.mjs", "docs/OPERATIONS.md", "docs/RELEASE.md", "docs/UPGRADING_PI.md"];
const exposedProfileCommands = ["profile:verify", "profile:list", "profile:check"];
const piVersion = expectedPiVersion;
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const sameStrings = (left, right) => Array.isArray(left) && left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
const sha256 = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const canonical = (value) => value === null ? "null" : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const digest = (value) => createHash("sha256").update(canonical(value)).digest("hex");

function validateManifest(pkg, label) {
  if (pkg.name !== "pi-reap" || pkg.version !== "1.0.0" || pkg.private === true) fail(`${label} expected public pi-reap 1.0.0 manifest`);
  if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes("pi-package")) fail(`${label} missing pi-package keyword`);
  if (!Array.isArray(pkg.pi?.extensions) || pkg.pi.extensions.length !== 1 || pkg.pi.extensions[0] !== "./src/index.ts") fail(`${label} missing explicit Pi extension entry`);
  if (pkg.peerDependencies?.["@earendil-works/pi-coding-agent"] !== piVersion || pkg.devDependencies?.["@earendil-works/pi-coding-agent"] !== piVersion || pkg.piReapCompatibility?.piCodingAgent !== `@earendil-works/pi-coding-agent@${piVersion}`) fail(`${label} Pi peer, development, or compatibility pin is not exactly 0.82.1`);
  if (pkg.piReapCompatibility.piExecutableSha256 !== expectedPiExecutableSha256 || pkg.piReapCompatibility.piRuntimeGraphSha256 !== expectedPiRuntimeGraphSha256 || pkg.piReapCompatibility.piCatalogSha256 !== expectedPiCatalogSha256) fail(`${label} exact Pi runtime graph fingerprints are stale`);
  if (!sameStrings(pkg.files, expectedFiles)) fail(`${label} package files are not the exact distributable set`);
  for (const command of exposedProfileCommands) if (pkg.scripts?.[command] !== `node scripts/profile-check.mjs --${command.slice("profile:".length)}`) fail(`${label} ${command} is not bound to the packaged safe profile command`);
  const scriptFiles = pkg.files.filter((path) => path.startsWith("scripts/"));
  if (!sameStrings(scriptFiles, ["scripts/profile-check.mjs"])) fail(`${label} includes an unsafe or unnecessary command script`);
}
function validateGraph(graphRoot) {
  try {
    return resolveStrictPiGraph({ graphRoot }).graphRoot;
  } catch (error) {
    fail(error instanceof Error ? error.message : "strict Pi graph validation failed");
  }
}
async function inspectTree(directory) {
  const manifest = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name); const rel = relative(directory, full);
      const info = await lstat(full);
      if (info.isSymbolicLink()) fail(`packed artifact contains symlink ${rel}`);
      if (info.isDirectory()) await walk(full);
      else if (info.isFile()) manifest.push({ path: rel, sha256: await sha256(full) });
      else fail(`packed artifact contains unsupported entry ${rel}`);
    }
  }
  await walk(directory);
  return manifest.sort((left, right) => left.path.localeCompare(right.path));
}

const sourceManifest = await readJson(resolve(root, "package.json"));
validateManifest(sourceManifest, "source");
for (const path of [sourceManifest.main, sourceManifest.types, sourceManifest.exports?.["."]?.import, sourceManifest.exports?.["."]?.types, ...sourceManifest.pi.extensions, "scripts/profile-check.mjs"]) {
  if (typeof path !== "string") fail("main, exports, types, extension, or profile command entry is missing");
  await access(resolve(root, path));
}
const graphRoot = validateGraph(resolve(process.env.PI_REAP_PACKAGE_GRAPH_ROOT ?? resolve(root, "node_modules")));
if (process.argv.includes("--graph-only")) {
  console.log("package graph check: exact Node/Pi precedence and Pi 0.82.1 fingerprints passed");
  process.exit(0);
}
const temporary = await mkdtemp(join(tmpdir(), "pi-reap-package-check-"));
try {
  const packs = resolve(temporary, "packs"); const unpacked = resolve(temporary, "unpacked");
  await mkdir(packs); await mkdir(unpacked);
  await exec("pnpm", ["pack", "--pack-destination", packs], { cwd: root });
  const archives = (await readdir(packs)).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1 || archives[0] !== "pi-reap-1.0.0.tgz") fail("real pack did not create the exact expected artifact");
  const archive = resolve(packs, archives[0]);
  await exec("tar", ["-xzf", archive, "-C", unpacked]);
  const packedRoot = resolve(unpacked, "package");
  if (basename(await realpath(packedRoot)) !== "package") fail("packed artifact root is invalid");
  const packedManifest = await readJson(resolve(packedRoot, "package.json"));
  validateManifest(packedManifest, "packed");
  const inventory = await inspectTree(packedRoot);
  const paths = new Set(inventory.map(({ path }) => path));
  for (const required of ["package.json", "dist/index.js", "dist/index.d.ts", "src/index.ts", "profiles/index.json", "scripts/profile-check.mjs"]) if (!paths.has(required)) fail(`packed artifact is missing ${required}`);
  if ([...paths].some((path) => path.startsWith("scripts/") && path !== "scripts/profile-check.mjs")) fail("packed artifact contains an unauthorized script");
  await symlink(graphRoot, resolve(packedRoot, "node_modules"), "dir");
  // Exercise Pi's real JITI-backed resource loader against the declared
  // packaged TypeScript source entry, not merely our built JS export.  The
  // bundled synthetic candidate has no config selection and must therefore
  // remain fail-closed while still loading as a valid Pi extension.
  const { loadExtensions } = await import(pathToFileURL(resolve(graphRoot, "@earendil-works/pi-coding-agent/dist/core/extensions/loader.js")).href);
  const sourceEntry = resolve(packedRoot, packedManifest.pi.extensions[0]);
  const approved = await writeSyntheticApprovedProfile(packedRoot);
  const originalCwd = process.cwd(); process.chdir(packedRoot);
  try {
    await writeSyntheticSelection(packedRoot, approved.id, approved.bindingDigest);
    const sourceLoaded = await loadExtensions([sourceEntry], packedRoot);
    if (sourceLoaded.errors.length !== 0 || sourceLoaded.extensions.length !== 1 || !sourceLoaded.extensions[0].commands.has("effort")) fail("Pi resource loader did not load the packed source extension entry");
    await drivePackedSourceHandlers(sourceLoaded.extensions[0], packedRoot, "approved", approved);
    await writeSyntheticSelection(packedRoot, "openai-responses-synthetic-candidate-r1", approved.candidateBindingDigest);
    const candidateLoaded = await loadExtensions([sourceEntry], packedRoot);
    await drivePackedSourceHandlers(candidateLoaded.extensions[0], packedRoot, "unresolved", approved);
    await writeSyntheticSelection(packedRoot, "unknown-profile", approved.bindingDigest);
    const unknownLoaded = await loadExtensions([sourceEntry], packedRoot);
    await drivePackedSourceHandlers(unknownLoaded.extensions[0], packedRoot, "unresolved", approved);
  } finally { process.chdir(originalCwd); }
  await import(`${pathToFileURL(resolve(packedRoot, packedManifest.main)).href}?package-check=1`);
  const verify = await exec("pnpm", ["run", "--silent", "profile:verify"], { cwd: packedRoot });
  const list = await exec("pnpm", ["run", "--silent", "profile:list"], { cwd: packedRoot });
  const profileId = list.stdout.trim().split(/\s+/)[0];
  if (!verify.stdout.includes("profile verification passed") || !profileId) fail("packed profile verify/list commands did not execute");
  const check = await exec("pnpm", ["run", "--silent", "profile:check", "--", "--id", profileId], { cwd: packedRoot });
  if (!check.stdout.includes("preserve-baseline")) fail("packed profile check command did not preserve baseline");
  console.log(`package check: real pack/unpack, ${inventory.length}-file inventory, exact Pi 0.82.1 graph, Pi-loaded packed source entry, built import, and all packed profile commands passed`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function writeSyntheticSelection(root, registryId, bindingDigest) {
  await mkdir(resolve(root, ".pi"), { recursive: true });
  await writeFile(resolve(root, ".pi/effort-router.json"), JSON.stringify({ enabled: true, mode: "enforce", profileActivation: { registryId, bindingDigest }, telemetry: { enabled: false, includePromptText: false, directory: "synthetic" }, ui: { showStatus: true, notifyOnEscalation: false } }));
}

async function writeSyntheticApprovedProfile(root) {
  const id = "package-smoke-synthetic-approved"; const source = { kind: "repository-pinned", repositoryRevision: "synthetic-package-smoke-r1" };
  const match = { provider: "synthetic", api: "openai-responses", model: "approved", modelCatalogRevision: "synthetic-r1", modelCatalogDigest: "a".repeat(64), piVersion: "0.82.1", providerAdapterRevision: "synthetic-r1", providerAdapterDigest: "b".repeat(64) };
  const capability = { schemaVersion: 1, profileId: id, profileRevision: "r1", source, match, rungs: [{ id: "economy", ordinal: 0, providerValue: "minimal", automaticEligible: true, explicitOnly: false }, { id: "high", ordinal: 1, providerValue: "high", automaticEligible: true, explicitOnly: false }], automaticFloor: "economy", automaticCeiling: "high", anchors: { economical: "economy", balanced: "high", deliberate: "high", exhaustive: "high" }, baselineBehavior: "preserve-request" };
  const admission = { schemaVersion: 1, profileId: `${id}-admission`, profileRevision: "r1", source, capabilityProfileId: id, capabilityProfileRevision: "r1", initial: { simpleQuery: { kind: "lowest-automatic" }, boundedRead: { kind: "lowest-automatic" }, implementation: { kind: "anchor", name: "balanced" }, debugging: { kind: "anchor", name: "deliberate" }, architecture: { kind: "automatic-ceiling" }, highRisk: { kind: "automatic-ceiling" }, continuation: { kind: "automatic-ceiling" }, unknown: { kind: "automatic-ceiling" } }, evidence: Object.fromEntries(["firstToolError", "repeatedToolError", "providerError", "lengthExhaustion", "overflowRetry", "failedContinuation"].map((key) => [key, { selector: { kind: "automatic-ceiling" } }])) };
  const capabilityDigest = digest(capability); const admissionDigest = digest(admission); const binding = { capability: { profileId: id, profileRevision: "r1", profileDigest: capabilityDigest }, admission: { profileId: `${id}-admission`, profileRevision: "r1", profileDigest: admissionDigest }, match }; const bindingDigest = digest(binding);
  await writeFile(resolve(root, "profiles/capability/package-smoke-approved.json"), JSON.stringify(capability)); await writeFile(resolve(root, "profiles/admission/package-smoke-approved.json"), JSON.stringify(admission));
  const index = await readJson(resolve(root, "profiles/index.json")); const candidateBindingDigest = index.profiles.find((entry) => entry.id === "openai-responses-synthetic-candidate-r1")?.bindingDigest; if (typeof candidateBindingDigest !== "string") fail("packed synthetic candidate is missing"); index.profiles.push({ id, state: "pinned", capability: { path: "capability/package-smoke-approved.json", profileId: id, profileRevision: "r1", profileDigest: capabilityDigest, source, match }, admission: { path: "admission/package-smoke-approved.json", profileId: `${id}-admission`, profileRevision: "r1", profileDigest: admissionDigest, source, capabilityProfileId: id, capabilityProfileRevision: "r1" }, bindingDigest }); await writeFile(resolve(root, "profiles/index.json"), JSON.stringify(index));
  return { id, bindingDigest, candidateBindingDigest };
}

async function drivePackedSourceHandlers(extension, cwd, expectation, approved) {
  const status = new Map(); const context = { cwd, model: { provider: "synthetic", api: "openai-responses", id: "approved", reasoning: true }, sessionManager: { getSessionId: () => "synthetic-package-smoke" }, ui: { setStatus: (key, value) => status.set(key, value), notify: () => {} } };
  const emit = async (name, event) => { for (const handler of extension.handlers.get(name) ?? []) await handler(event, context); };
  await emit("session_start", { type: "session_start", reason: "new" }); await emit("input", { type: "input", text: "raw", source: "interactive" }); await emit("before_agent_start", { type: "before_agent_start", prompt: "implement expanded synthetic package work", systemPrompt: "", systemPromptOptions: {} });
  const payload = { reasoning: { preserve: true }, cache: { key: "unchanged" } }; const result = await (async () => { let output; for (const handler of extension.handlers.get("before_provider_request") ?? []) { const next = await handler({ type: "before_provider_request", payload }, context); if (next !== undefined) output = next; } return output; })();
  if (expectation === "approved") { if (!status.get("pi-reap")?.includes("rung:auto → high") || result !== undefined || canonical(payload) !== canonical({ reasoning: { preserve: true }, cache: { key: "unchanged" } })) fail(`packed source activation did not produce resolved shadow routing without changing payload (status=${status.get("pi-reap") ?? "missing"}, result=${result === undefined ? "unchanged" : "patched"})`); }
  else if (status.get("pi-reap")?.includes(`profile:${approved.id}`) || result !== undefined) fail("candidate or unknown packed selection did not remain unresolved");
}
