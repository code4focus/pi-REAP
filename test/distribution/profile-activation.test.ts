import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { canonicalProfileDigest, createProfileBinding } from "../../src/domain/profile.js";
import { loadProductionProfileActivation } from "../../src/distribution/profile-activation.js";
import { createExtension } from "../../src/index.js";
import { ExtensionHarness } from "../integration/extension-harness.js";

const match = { provider: "synthetic", api: "openai-responses", model: "approved", modelCatalogRevision: "r1", modelCatalogDigest: "a".repeat(64), piVersion: "0.82.1", providerAdapterRevision: "r1", providerAdapterDigest: "b".repeat(64) };
const execFileAsync = promisify(execFile);
async function registry(state: "candidate" | "qualified" | "pinned") {
  const root = await mkdtemp(join(tmpdir(), "pi-reap-profile-activation-"));
  await Promise.all([mkdir(join(root, "capability")), mkdir(join(root, "admission"))]);
  const source = state === "candidate" ? { kind: "validated-catalog-candidate", authority: "candidate-only", evidenceDigest: "c".repeat(64) } : state === "qualified" ? { kind: "user-approved-local", approvalDigest: "c".repeat(64) } : { kind: "repository-pinned", repositoryRevision: "synthetic-r1" };
  const capability = { schemaVersion: 1, profileId: "approved", profileRevision: "r1", source, match, rungs: [{ id: "economy", ordinal: 0, providerValue: "minimal", automaticEligible: true, explicitOnly: false }, { id: "high", ordinal: 1, providerValue: "high", automaticEligible: true, explicitOnly: false }], automaticFloor: "economy", automaticCeiling: "high", anchors: { economical: "economy", balanced: "high", deliberate: "high", exhaustive: "high" }, baselineBehavior: "preserve-request" };
  const admission = { schemaVersion: 1, profileId: "approved-admission", profileRevision: "r1", source, capabilityProfileId: "approved", capabilityProfileRevision: "r1", initial: { simpleQuery: { kind: "lowest-automatic" }, boundedRead: { kind: "lowest-automatic" }, implementation: { kind: "anchor", name: "balanced" }, debugging: { kind: "anchor", name: "deliberate" }, architecture: { kind: "automatic-ceiling" }, highRisk: { kind: "automatic-ceiling" }, continuation: { kind: "automatic-ceiling" }, unknown: { kind: "automatic-ceiling" } }, evidence: Object.fromEntries(["firstToolError", "repeatedToolError", "providerError", "lengthExhaustion", "overflowRetry", "failedContinuation"].map((key) => [key, { selector: { kind: "automatic-ceiling" } }])) };
  const binding = createProfileBinding(capability, admission); if (!binding.ok) throw new Error("synthetic binding");
  const cap = canonicalProfileDigest(capability); const adm = canonicalProfileDigest(admission); const all = canonicalProfileDigest(binding.binding);
  if (!cap.ok || !adm.ok || !all.ok) throw new Error("synthetic digests");
  await writeFile(join(root, "capability/profile.json"), JSON.stringify(capability)); await writeFile(join(root, "admission/profile.json"), JSON.stringify(admission));
  await writeFile(join(root, "index.json"), JSON.stringify({ format: 1, profiles: [{ id: "approved", state, capability: { path: "capability/profile.json", profileId: capability.profileId, profileRevision: capability.profileRevision, profileDigest: cap.digest, source, match }, admission: { path: "admission/profile.json", profileId: admission.profileId, profileRevision: admission.profileRevision, profileDigest: adm.digest, source, capabilityProfileId: capability.profileId, capabilityProfileRevision: capability.profileRevision }, bindingDigest: all.digest }] }));
  return { root, digest: all.digest };
}

type FormerVerifierMutation = readonly [
  formerCondition: string,
  mutation: string,
  mutate: (root: string) => Promise<string | void>,
];
interface MutableSource extends Record<string, unknown> {
  kind: string;
  authority?: string;
  evidenceDigest?: string;
  fixtureId?: string;
  approvalDigest?: string;
  repositoryRevision?: string;
}
interface MutableMatch extends Record<string, unknown> {
  provider: string;
  api: string;
  model: string;
  modelCatalogRevision: string;
  modelCatalogDigest: string;
  piVersion: string;
  providerAdapterRevision: string;
  providerAdapterDigest: string;
}
interface MutableRung extends Record<string, unknown> {
  id: string;
  ordinal: number;
  providerValue: unknown;
  automaticEligible: unknown;
  explicitOnly: unknown;
  aliases?: unknown;
}
interface MutableCapability extends Record<string, unknown> {
  schemaVersion: number;
  profileId: string;
  profileRevision: string;
  source: MutableSource;
  match: MutableMatch;
  rungs: MutableRung[] & { 0: MutableRung; 1: MutableRung };
  automaticFloor: string;
  automaticCeiling: string;
  explicitCeiling?: string;
  anchors: Record<string, string>;
  baselineBehavior: string;
}
interface MutableSelector extends Record<string, unknown> {
  kind: string;
  name?: string;
}
interface MutableEvidenceRule extends Record<string, unknown> {
  selector: MutableSelector;
}
interface MutableAdmission extends Record<string, unknown> {
  schemaVersion: number;
  profileId: string;
  profileRevision: string;
  source: MutableSource;
  capabilityProfileId: string;
  capabilityProfileRevision: string;
  initial: Record<string, MutableSelector | null> & { simpleQuery: MutableSelector | null };
  evidence: Record<string, MutableEvidenceRule> & { firstToolError: MutableEvidenceRule };
}
interface MutableCapabilityPin extends Record<string, unknown> {
  path: string;
  profileId: string;
  profileRevision: string;
  profileDigest: string;
  source: MutableSource;
  match: MutableMatch;
}
interface MutableAdmissionPin extends Record<string, unknown> {
  path: string;
  profileId: string;
  profileRevision: string;
  profileDigest: string;
  source: MutableSource;
  capabilityProfileId: string;
  capabilityProfileRevision: string;
}
interface MutableRegistryEntry extends Record<string, unknown> {
  id: string;
  state: string;
  capability: MutableCapabilityPin;
  admission: MutableAdmissionPin;
  bindingDigest: string;
}
interface MutableRegistry extends Record<string, unknown> {
  format: number;
  profiles: MutableRegistryEntry[] & { 0: MutableRegistryEntry };
}

/**
 * Executable condition map for every rejection branch in
 * cdb87ae:scripts/profile-check.mjs. Repeated calls to the former exactKeys,
 * string, SHA-256, source, match, selector, and schema helpers are represented
 * at each distinct contract boundary. The former candidate-only branch is
 * represented by an unknown state: qualified and pinned are the intentional
 * PR 7 state-domain extension, and remain source-authority constrained.
 */
const FORMER_VERIFIER_MUTATIONS: readonly FormerVerifierMutation[] = [
  ["exactKeys(registry)", "unknown registry field", async (root) => mutateIndex(root, (index) => { index.extra = true; })],
  ["registry format/profiles", "unknown registry format", async (root) => mutateIndex(root, (index) => { index.format = 2; })],
  ["registry format/profiles", "empty profile registry", async (root) => mutateIndex(root, (index) => { index.profiles = [] as unknown as MutableRegistry["profiles"]; })],
  ["exactKeys(registry entry)", "unknown registry-entry field", async (root) => mutateEntry(root, (entry) => { entry.extra = true; })],
  ["string(registry entry ID)", "empty registry-entry ID", async (root) => mutateEntry(root, (entry) => { entry.id = ""; })],
  ["sha256(bindingDigest)", "malformed binding digest", async (root) => mutateEntry(root, (entry) => { entry.bindingDigest = "not-a-digest"; })],
  ["candidate-only state / PR 7 closed state union", "unknown registry state", async (root) => mutateEntry(root, (entry) => { entry.state = "promoted"; })],
  ["seenIds", "duplicate registry ID", async (root) => mutateIndex(root, (index) => { index.profiles.push(structuredClone(index.profiles[0])); })],
  ["exactKeys(capability pin)", "unknown capability-pin field", async (root) => mutateEntry(root, (entry) => { entry.capability.extra = true; })],
  ["exactKeys(admission pin)", "unknown admission-pin field", async (root) => mutateEntry(root, (entry) => { entry.admission.extra = true; })],
  ["string(pin identity)", "empty pinned profile identity", async (root) => mutateEntry(root, (entry) => { entry.capability.profileId = ""; })],
  ["sha256(profileDigest)", "malformed pinned content digest", async (root) => mutateEntry(root, (entry) => { entry.capability.profileDigest = "not-a-digest"; })],
  ["validateSource(pin)", "invalid state-specific pin authority", async (root) => mutateEntry(root, (entry) => { entry.capability.source.repositoryRevision = ""; })],
  ["seenPaths", "duplicate profile path", async (root) => appendDuplicateEntry(root, "path")],
  ["seenProfileIds", "duplicate pinned profile identity", async (root) => appendDuplicateEntry(root, "profileId")],
  ["exactKeys(match)", "unknown pinned-match field", async (root) => mutateEntry(root, (entry) => { entry.capability.match.extra = true; })],
  ["string(match field)", "empty pinned-match provider", async (root) => mutateEntry(root, (entry) => { entry.capability.match.provider = ""; })],
  ["sha256(match digest)", "malformed pinned catalog digest", async (root) => mutateEntry(root, (entry) => { entry.capability.match.modelCatalogDigest = "not-a-digest"; })],
  ["exact Pi identity", "stale pinned Pi identity", async (root) => mutateEntry(root, (entry) => { entry.capability.match.piVersion = "0.82.2"; })],
  ["loadContained path", "uncontained capability path", async (root) => mutateEntry(root, (entry) => { entry.capability.path = "../capability/profile.json"; })],
  ["loadContained regular file", "symlinked capability profile", symlinkCapabilityFile],
  ["loadContained realpath containment", "ancestor-symlink escape", escapeCapabilityDirectory],
  ["loadContained JSON", "invalid capability JSON", async (root) => writeFile(capabilityPath(root), "{")],
  ["exactKeys(capability)", "unknown capability field", async (root) => mutateCapability(root, (capability) => { capability.extra = true; })],
  ["capability schema", "unknown capability schema", async (root) => mutateCapability(root, (capability) => { capability.schemaVersion = 2; })],
  ["string(capability identity)", "empty capability revision", mutateCapabilityRevisionWithoutPin],
  ["validateSource(capability)", "invalid capability source authority", mutateCapabilitySourceWithoutPin],
  ["validateMatch(capability)", "stale capability Pi identity", mutateCapabilityMatchWithoutPin],
  ["capability rung cardinality", "fewer than two rungs", async (root) => mutateCapability(root, (capability) => { capability.rungs.pop(); })],
  ["exactKeys(rung)", "unknown rung field", async (root) => mutateCapability(root, (capability) => { capability.rungs[0].extra = true; })],
  ["string(rung ID)", "empty rung ID", async (root) => mutateCapability(root, (capability) => { capability.rungs[0].id = ""; })],
  ["rung mapping", "duplicate rung ID", async (root) => mutateCapability(root, (capability) => { capability.rungs[1].id = capability.rungs[0].id; })],
  ["rung mapping", "stale rung ordinal", async (root) => mutateCapability(root, (capability) => { capability.rungs[0].ordinal = 4; })],
  ["rung mapping", "non-string provider value with fully rebound pins", async (root) => mutateCapability(root, (capability) => { capability.rungs[0].providerValue = { wire: "object" }; })],
  ["rung mapping", "non-boolean automatic eligibility", async (root) => mutateCapability(root, (capability) => { capability.rungs[0].automaticEligible = "true"; })],
  ["rung mapping", "non-boolean explicit-only flag", async (root) => mutateCapability(root, (capability) => { capability.rungs[0].explicitOnly = 0; })],
  ["rung mapping", "conflicted eligibility flags", async (root) => mutateCapability(root, (capability) => { capability.rungs[0].explicitOnly = true; })],
  ["rung aliases", "non-array aliases", async (root) => mutateCapability(root, (capability) => { capability.rungs[0].aliases = "economical"; })],
  ["rung aliases", "non-string alias", async (root) => mutateCapability(root, (capability) => { capability.rungs[0].aliases = [1]; })],
  ["exactKeys(anchors)", "unknown anchor field", async (root) => mutateCapability(root, (capability) => { capability.anchors.extra = "economy"; })],
  ["stale rung binding", "unknown anchor rung", async (root) => mutateCapability(root, (capability) => { capability.anchors.economical = "missing"; })],
  ["stale rung binding", "unknown automatic floor", async (root) => mutateCapability(root, (capability) => { capability.automaticFloor = "missing"; })],
  ["stale rung binding", "unknown automatic ceiling", async (root) => mutateCapability(root, (capability) => { capability.automaticCeiling = "missing"; })],
  ["stale rung binding", "unknown explicit ceiling", async (root) => mutateCapability(root, (capability) => { capability.explicitCeiling = "missing"; })],
  ["baseline preservation", "non-preserving baseline", async (root) => mutateCapability(root, (capability) => { capability.baselineBehavior = "known-profile-default"; })],
  ["exactKeys(admission)", "unknown admission field", async (root) => mutateAdmission(root, (admission) => { admission.extra = true; })],
  ["admission schema", "unknown admission schema", async (root) => mutateAdmission(root, (admission) => { admission.schemaVersion = 2; })],
  ["string(admission identity)", "empty admission revision", mutateAdmissionRevisionWithoutPin],
  ["validateSource(admission)", "invalid admission source authority", mutateAdmissionSourceWithoutPin],
  ["exactKeys(initial routes)", "unknown initial-route field", async (root) => mutateAdmission(root, (admission) => { admission.initial.extra = { kind: "automatic-ceiling" }; })],
  ["selector shape", "non-record initial selector", async (root) => mutateAdmission(root, (admission) => { admission.initial.simpleQuery = null; })],
  ["exactKeys(anchor selector)", "unknown anchor-selector field", async (root) => mutateAdmission(root, (admission) => { admission.initial.simpleQuery = { kind: "anchor", name: "economical", extra: true }; })],
  ["known anchor selector", "unknown anchor selector", async (root) => mutateAdmission(root, (admission) => { admission.initial.simpleQuery = { kind: "anchor", name: "unknown" }; })],
  ["exactKeys(non-anchor selector)", "unknown non-anchor-selector field", async (root) => mutateAdmission(root, (admission) => { admission.initial.simpleQuery = { kind: "lowest-automatic", extra: true }; })],
  ["known non-anchor selector", "unknown selector kind", async (root) => mutateAdmission(root, (admission) => { admission.initial.simpleQuery = { kind: "highest" }; })],
  ["exactKeys(evidence routes)", "unknown evidence-route field", async (root) => mutateAdmission(root, (admission) => { admission.evidence.extra = { selector: { kind: "automatic-ceiling" } }; })],
  ["exactKeys(evidence route)", "unknown evidence-rule field", async (root) => mutateAdmission(root, (admission) => { admission.evidence.firstToolError.extra = true; })],
  ["selector(evidence route)", "invalid evidence selector", async (root) => mutateAdmission(root, (admission) => { admission.evidence.firstToolError.selector = { kind: "highest" }; })],
  ["content digest equality", "unrebound profile content", async (root) => mutateCapability(root, (capability) => { capability.rungs[0].providerValue = "changed-unrebound"; }, false)],
  ["identity agreement", "capability ID disagrees with registry ID", async (root) => mutateCapability(root, (capability) => { capability.profileId = "other"; })],
  ["revision coordination", "admission revision disagrees with capability", async (root) => mutateAdmission(root, (admission) => { admission.profileRevision = "r2"; })],
  ["revision coordination", "admission capability reference is stale", async (root) => mutateAdmission(root, (admission) => { admission.capabilityProfileId = "other"; })],
  ["source agreement", "capability and admission sources disagree", async (root) => mutateCapability(root, (capability) => { capability.source.repositoryRevision = "other"; })],
  ["match agreement", "profile match disagrees with registry pin", mutateProfileMatchWithoutPin],
  ["binding digest equality", "stale combined binding digest", async (root) => mutateEntry(root, (entry) => { entry.bindingDigest = "0".repeat(64); })],
  ["indexedFiles entry type", "non-JSON file in profile directory", async (root) => writeFile(join(root, "capability/note.txt"), "not a profile")],
  ["indexed/discovered equality", "unindexed JSON profile", async (root) => writeFile(join(root, "capability/unindexed.json"), "{}")],
  ["registry regular file", "symlinked registry", symlinkRegistryFile],
];

describe("read-only production activation", () => {
  it("loads an exact qualified or pinned shadow profile and rejects candidate, unknown, and mismatched selections", async () => {
    const qualified = await registry("qualified");
    await expect(loadProductionProfileActivation({ root: qualified.root, registryId: "approved", bindingDigest: qualified.digest })).resolves.toMatchObject({ modelCatalogRevision: "r1" });
    await expect(loadProductionProfileActivation({ root: qualified.root, registryId: "other", bindingDigest: qualified.digest })).resolves.toBeUndefined();
    await expect(loadProductionProfileActivation({ root: qualified.root, registryId: "approved", bindingDigest: "0".repeat(64) })).resolves.toBeUndefined();
    const candidate = await registry("candidate");
    await expect(loadProductionProfileActivation({ root: candidate.root, registryId: "approved", bindingDigest: candidate.digest })).resolves.toBeUndefined();
    const pinned = await registry("pinned");
    await expect(loadProductionProfileActivation({ root: pinned.root, registryId: "approved", bindingDigest: pinned.digest })).resolves.toMatchObject({ piVersion: "0.82.1" });
  });
  it.each([
    ["relabelled candidate", "candidate", (entry: Record<string, unknown>) => { entry.state = "pinned"; }],
    ["qualified/pinned source hybrid", "qualified", (entry: Record<string, unknown>) => { entry.state = "pinned"; }],
    ["forged registry match", "pinned", (entry: Record<string, unknown>) => { ((entry.capability as Record<string, unknown>).match as Record<string, unknown>).model = "forged"; }],
    ["extra registry field", "pinned", (entry: Record<string, unknown>) => { entry.extra = true; }],
  ] as const)("rejects %s without activating", async (_name, state, mutate) => {
    const fixture = await registry(state); const indexPath = join(fixture.root, "index.json"); const index = JSON.parse(await readFile(indexPath, "utf8")); mutate(index.profiles[0]); await writeFile(indexPath, JSON.stringify(index));
    await expect(loadProductionProfileActivation({ root: fixture.root, registryId: "approved", bindingDigest: fixture.digest })).resolves.toBeUndefined();
  });
  it("ignores production profile-root environment variables", async () => {
    const fixture = await registry("pinned"); const previous = process.env.PI_REAP_PROFILES_ROOT; process.env.PI_REAP_PROFILES_ROOT = fixture.root;
    try { await expect(loadProductionProfileActivation({ registryId: "approved", bindingDigest: fixture.digest })).resolves.toBeUndefined(); }
    finally { if (previous === undefined) delete process.env.PI_REAP_PROFILES_ROOT; else process.env.PI_REAP_PROFILES_ROOT = previous; }
  });
  it.each([
    ["top-level extra", async (root: string) => { const p = join(root, "index.json"); const x = JSON.parse(await readFile(p, "utf8")); x.extra = true; await writeFile(p, JSON.stringify(x)); }],
    ["nonselected invalid entry", async (root: string) => { const p = join(root, "index.json"); const x = JSON.parse(await readFile(p, "utf8")); x.profiles.push({ id: "other", state: "pinned" }); await writeFile(p, JSON.stringify(x)); }],
    ["duplicate entry", async (root: string) => { const p = join(root, "index.json"); const x = JSON.parse(await readFile(p, "utf8")); x.profiles.push(x.profiles[0]); await writeFile(p, JSON.stringify(x)); }],
    ["unindexed file", async (root: string) => { await writeFile(join(root, "capability/unindexed.json"), "{}"); }],
  ])("rejects global registry mutation: %s", async (_name, mutate) => {
    const fixture = await registry("pinned"); await mutate(fixture.root);
    await expect(loadProductionProfileActivation({ root: fixture.root, registryId: "approved", bindingDigest: fixture.digest })).resolves.toBeUndefined();
  });
  it("routes a loaded approved profile in shadow without changing the provider payload", async () => {
    const approved = await registry("qualified");
    const activation = await loadProductionProfileActivation({ root: approved.root, registryId: "approved", bindingDigest: approved.digest });
    if (!activation) throw new Error("synthetic approved activation was not loaded");
    const harness = new ExtensionHarness(); harness.setModel({ provider: "synthetic", api: "openai-responses", id: "approved" });
    await createExtension({ activation, load: async () => ({ enabled: true, mode: "enforce", telemetry: { enabled: false, includePromptText: false, directory: "synthetic" }, ui: { showStatus: true, notifyOnEscalation: false } }) })(harness.api());
    harness.start(); harness.input("short raw input"); harness.before("implement the expanded approved work item");
    const payload = { reasoning: { keep: "unchanged" }, cache: { key: "preserved" } };
    expect(harness.request(payload)).toBeUndefined();
    expect(payload).toEqual({ reasoning: { keep: "unchanged" }, cache: { key: "preserved" } });
    expect(harness.status.get("pi-reap")).toContain("rung:auto → high");
  });

  it.each(FORMER_VERIFIER_MUTATIONS)("preserves former verifier condition %s: %s", async (_condition, _name, mutate) => {
    const fixture = await registry("pinned"); const rejectedRoot = await mutate(fixture.root) ?? fixture.root;
    await assertRejectedByBoth(rejectedRoot, fixture.digest);
  });

  it("rejects the fully rebound object providerValue reproduction in verifier and production activation", async () => {
    const fixture = await registry("pinned");
    await mutateCapability(fixture.root, (capability) => { capability.rungs[0].providerValue = { wire: "object" }; });
    const index = await json(join(fixture.root, "index.json")); const reboundDigest = index.profiles[0].bindingDigest;
    await expect(execFileAsync(process.execPath, ["scripts/profile-check.mjs", "--verify"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_PROFILES_ROOT: fixture.root } })).rejects.toMatchObject({ stderr: expect.stringContaining("duplicate, stale, or conflicted rung mapping") });
    await expect(loadProductionProfileActivation({ root: fixture.root, registryId: "approved", bindingDigest: reboundDigest })).resolves.toBeUndefined();
  });

  it("uses the shared decoder to reject a symlinked profile root", async () => {
    const fixture = await registry("pinned"); const link = `${fixture.root}-link`; await symlink(fixture.root, link, "dir");
    await assertRejectedByBoth(link, fixture.digest);
  });

  it.each(["none", "low", "medium", "high", "xhigh", "max", "provider/profile-specific:exact-v1"])("preserves exact string provider value %s", async (providerValue) => {
    const fixture = await registry("pinned");
    await mutateCapability(fixture.root, (capability) => { capability.rungs[0].providerValue = providerValue; });
    const index = await json(join(fixture.root, "index.json")); const reboundDigest = index.profiles[0].bindingDigest;
    await expect(execFileAsync(process.execPath, ["scripts/profile-check.mjs", "--verify"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_PROFILES_ROOT: fixture.root } })).resolves.toMatchObject({ stdout: expect.stringContaining("profile verification passed") });
    await expect(loadProductionProfileActivation({ root: fixture.root, registryId: "approved", bindingDigest: reboundDigest })).resolves.toMatchObject({ piVersion: "0.82.1" });
  });

  it("preserves the unknown profile-check fail-closed contract", async () => {
    const fixture = await registry("pinned");
    await expect(execFileAsync(process.execPath, ["scripts/profile-check.mjs", "--check", "--id", "missing"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_PROFILES_ROOT: fixture.root } })).rejects.toMatchObject({ stderr: expect.stringContaining("unknown profile identity preserves baseline") });
    await expect(loadProductionProfileActivation({ root: fixture.root, registryId: "missing", bindingDigest: fixture.digest })).resolves.toBeUndefined();
  });
});

const capabilityPath = (root: string) => join(root, "capability/profile.json");
const admissionPath = (root: string) => join(root, "admission/profile.json");
async function json<T = MutableRegistry>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }
async function writeJson(path: string, value: unknown) { await writeFile(path, JSON.stringify(value)); }
async function mutateIndex(root: string, mutate: (index: MutableRegistry) => void) {
  const path = join(root, "index.json"); const index = await json(path); mutate(index); await writeJson(path, index);
}
async function mutateEntry(root: string, mutate: (entry: MutableRegistryEntry) => void) {
  await mutateIndex(root, (index) => mutate(index.profiles[0]));
}
async function mutateCapability(root: string, mutate: (capability: MutableCapability) => void, rebound = true) {
  const capability = await json<MutableCapability>(capabilityPath(root)); mutate(capability); await writeJson(capabilityPath(root), capability); if (rebound) await rebind(root);
}
async function mutateAdmission(root: string, mutate: (admission: MutableAdmission) => void, rebound = true) {
  const admission = await json<MutableAdmission>(admissionPath(root)); mutate(admission); await writeJson(admissionPath(root), admission); if (rebound) await rebind(root);
}
async function appendDuplicateEntry(root: string, duplicate: "path" | "profileId") {
  const index = await json(join(root, "index.json")); const second = structuredClone(index.profiles[0]); second.id = "second";
  if (duplicate === "profileId") {
    second.capability.path = "capability/second.json"; second.admission.path = "admission/second.json";
    await cp(capabilityPath(root), join(root, second.capability.path)); await cp(admissionPath(root), join(root, second.admission.path));
  }
  index.profiles.push(second); await writeJson(join(root, "index.json"), index);
}
async function symlinkCapabilityFile(root: string) {
  const outside = join(await mkdtemp(join(tmpdir(), "pi-reap-profile-outside-")), "profile.json");
  await cp(capabilityPath(root), outside); await unlink(capabilityPath(root)); await symlink(outside, capabilityPath(root));
}
async function escapeCapabilityDirectory(root: string) {
  const outside = await mkdtemp(join(tmpdir(), "pi-reap-profile-directory-outside-"));
  await cp(capabilityPath(root), join(outside, "profile.json")); await rename(join(root, "capability"), join(root, "capability-original")); await symlink(outside, join(root, "capability"), "dir");
}
async function symlinkRegistryFile(root: string) {
  const outside = join(await mkdtemp(join(tmpdir(), "pi-reap-registry-outside-")), "index.json");
  await cp(join(root, "index.json"), outside); await unlink(join(root, "index.json")); await symlink(outside, join(root, "index.json"));
}
async function mutateProfileMatchWithoutPin(root: string) {
  const index = await json(join(root, "index.json")); const pinnedMatch = structuredClone(index.profiles[0].capability.match);
  await mutateCapability(root, (capability) => { capability.match.model = "other"; });
  const rebound = await json(join(root, "index.json")); rebound.profiles[0].capability.match = pinnedMatch; await writeJson(join(root, "index.json"), rebound);
}
async function mutateCapabilityRevisionWithoutPin(root: string) {
  const index = await json(join(root, "index.json")); const pinnedRevision = index.profiles[0].capability.profileRevision;
  await mutateCapability(root, (capability) => { capability.profileRevision = ""; });
  const rebound = await json(join(root, "index.json")); rebound.profiles[0].capability.profileRevision = pinnedRevision; await writeJson(join(root, "index.json"), rebound);
}
async function mutateAdmissionRevisionWithoutPin(root: string) {
  const index = await json(join(root, "index.json")); const pinnedRevision = index.profiles[0].admission.profileRevision;
  await mutateAdmission(root, (admission) => { admission.profileRevision = ""; });
  const rebound = await json(join(root, "index.json")); rebound.profiles[0].admission.profileRevision = pinnedRevision; await writeJson(join(root, "index.json"), rebound);
}
async function mutateCapabilitySourceWithoutPin(root: string) {
  const index = await json(join(root, "index.json")); const pinnedSource = structuredClone(index.profiles[0].capability.source);
  await mutateCapability(root, (capability) => { capability.source.repositoryRevision = ""; });
  const rebound = await json(join(root, "index.json")); rebound.profiles[0].capability.source = pinnedSource; await writeJson(join(root, "index.json"), rebound);
}
async function mutateAdmissionSourceWithoutPin(root: string) {
  const index = await json(join(root, "index.json")); const pinnedSource = structuredClone(index.profiles[0].admission.source);
  await mutateAdmission(root, (admission) => { admission.source.repositoryRevision = ""; });
  const rebound = await json(join(root, "index.json")); rebound.profiles[0].admission.source = pinnedSource; await writeJson(join(root, "index.json"), rebound);
}
async function mutateCapabilityMatchWithoutPin(root: string) {
  const index = await json(join(root, "index.json")); const pinnedMatch = structuredClone(index.profiles[0].capability.match);
  await mutateCapability(root, (capability) => { capability.match.piVersion = "0.82.2"; });
  const rebound = await json(join(root, "index.json")); rebound.profiles[0].capability.match = pinnedMatch; await writeJson(join(root, "index.json"), rebound);
}
async function rebind(root: string, suppliedIndex?: MutableRegistry) {
  const index = suppliedIndex ?? await json<MutableRegistry>(join(root, "index.json"));
  const capability = await json<MutableCapability>(capabilityPath(root)); const admission = await json<MutableAdmission>(admissionPath(root)); const entry = index.profiles[0];
  const cap = canonicalProfileDigest(capability); const adm = canonicalProfileDigest(admission);
  if (!cap.ok || !adm.ok) throw new Error("synthetic mutation digests");
  entry.capability.profileId = capability.profileId; entry.capability.profileRevision = capability.profileRevision; entry.capability.profileDigest = cap.digest; entry.capability.source = capability.source; entry.capability.match = capability.match;
  entry.admission.profileId = admission.profileId; entry.admission.profileRevision = admission.profileRevision; entry.admission.profileDigest = adm.digest; entry.admission.source = admission.source; entry.admission.capabilityProfileId = admission.capabilityProfileId; entry.admission.capabilityProfileRevision = admission.capabilityProfileRevision;
  const binding = { capability: { profileId: capability.profileId, profileRevision: capability.profileRevision, profileDigest: cap.digest }, admission: { profileId: admission.profileId, profileRevision: admission.profileRevision, profileDigest: adm.digest }, match: capability.match };
  const bound = canonicalProfileDigest(binding); if (!bound.ok) throw new Error("synthetic mutation binding"); entry.bindingDigest = bound.digest;
  await writeJson(join(root, "index.json"), index);
}
async function assertRejectedByBoth(root: string, digest: string) {
  const index = await json(join(root, "index.json")); const selected = index.profiles.at(0); const selectedDigest = typeof selected?.bindingDigest === "string" ? selected.bindingDigest : digest;
  await expect(loadProductionProfileActivation({ root, registryId: "approved", bindingDigest: selectedDigest })).resolves.toBeUndefined();
  await expect(execFileAsync(process.execPath, ["scripts/profile-check.mjs", "--verify"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_PROFILES_ROOT: root } })).rejects.toBeDefined();
}
