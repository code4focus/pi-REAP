import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
type RollbackFixture = {
  recordId: string; priorArtifactIdentity: string; bindingDigest: string;
  verification: { status: string; releaseSequence: number };
  artifact: {
    identity: { artifactId: string; packageName: string; packageVersion: string; sourceFingerprint: string; buildFingerprint: string };
    binding: {
      capability: { profileId: string; profileRevision: string; profileDigest: string; source: { repositoryRevision: string } };
      admission: { profileId: string; profileRevision: string; profileDigest: string; source: { repositoryRevision: string }; capabilityProfileId: string; capabilityProfileRevision: string };
      match: { modelCatalogDigest: string; providerAdapterDigest: string; piVersion: string };
    };
  };
};
const canonical = (value: unknown): string => value === null ? "null" : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : typeof value === "object" ? `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value) ?? "undefined";
const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const rebindRollback = (value: RollbackFixture): void => { value.bindingDigest = digest({ priorArtifactIdentity: value.priorArtifactIdentity, artifact: value.artifact }); };
const paths = [
  ["openai-codex-responses/first-turn.json", "openai-codex-responses"], ["openai-codex-responses/tool-continuation.json", "openai-codex-responses"],
  ["openai-codex-responses/reasoning-replay.json", "openai-codex-responses"], ["openai-codex-responses/compacted-session.json", "openai-codex-responses"],
  ["openai-responses/first-turn.json", "openai-responses"], ["openai-responses/tool-continuation.json", "openai-responses"], ["openai-responses/reasoning-replay.json", "openai-responses"],
] as const;
const synthetic = { fixture_provenance: "synthetic sanitized fixture; not a captured real Pi request", reasoning: { effort: "high" }, instructions: "[synthetic sanitized instructions]", input: [{ role: "user", content: "[synthetic sanitized content]" }] };
async function fixtureRoot(mutate?: (manifest: Record<string, unknown>, directory: string) => void | Promise<void>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-reap-fixture-adversarial-"));
  const manifest: Record<string, unknown> = { format: 1, compatibility: { package: "@earendil-works/pi-coding-agent", version: "0.82.1", upstreamCommit: "cee5ff7520d8828bed9955ef00419e995d1f91e0" }, fixtures: paths.map(([path, api]) => ({ path, api, provenance: "synthetic" })) };
  for (const [path] of paths) { await mkdir(join(directory, path, ".."), { recursive: true }); await writeFile(join(directory, path), await readFile(join(process.cwd(), "test/fixtures", path))); }
  await mutate?.(manifest, directory); await writeFile(join(directory, "final-payload-manifest.json"), JSON.stringify(manifest)); return directory;
}
async function rejectsFixture(directory: string, text: string): Promise<void> {
  await expect(execFileAsync(process.execPath, ["scripts/verify-pi-fixtures.mjs"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_FIXTURE_ROOT: directory } })).rejects.toMatchObject({ stderr: expect.stringContaining(text) });
}
async function fakePiGraph(options: { version: string; complete: boolean }): Promise<string> {
  const graph = await mkdtemp(join(tmpdir(), "pi-reap-fake-pi-graph-"));
  const scope = join(graph, "@earendil-works");
  const packages = {
    coding: join(scope, "pi-coding-agent"),
    ai: join(scope, "pi-ai"),
    core: join(scope, "pi-agent-core"),
  };
  const write = async (root: string, path: string, contents = "export {};\n") => { const full = join(root, path); await mkdir(dirname(full), { recursive: true }); await writeFile(full, contents); };
  await write(packages.coding, "package.json", JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: options.version, bin: { pi: "dist/cli.js" } }));
  await write(packages.coding, "dist/cli.js", "#!/usr/bin/env node\n"); await chmod(join(packages.coding, "dist/cli.js"), 0o755);
  if (!options.complete) return graph;
  await write(packages.ai, "package.json", JSON.stringify({ name: "@earendil-works/pi-ai", version: options.version }));
  await write(packages.core, "package.json", JSON.stringify({ name: "@earendil-works/pi-agent-core", version: options.version }));
  for (const path of ["dist/index.js", "dist/core/sdk.js", "dist/core/agent-session.js", "dist/core/model-runtime.js", "dist/core/resource-loader.js", "dist/core/settings-manager.js", "dist/core/session-manager.js", "dist/core/extensions/loader.js", "dist/core/extensions/runner.js", "dist/core/auth-storage.js"]) await write(packages.coding, path);
  for (const path of ["dist/agent.js", "dist/agent-loop.js"]) await write(packages.core, path);
  for (const path of ["dist/models.js", "dist/auth/resolve.js", "dist/api/openai-codex-responses.js", "dist/api/openai-responses-shared.js"]) await write(packages.ai, path);
  await write(packages.ai, "dist/providers/data/openai-codex.json", "{}\n");
  return graph;
}
async function exactSiblingPiGraph(): Promise<{ graph: string; packages: Record<"coding" | "ai" | "core", string> }> {
  const graph = await mkdtemp(join(tmpdir(), "pi-reap-exact-sibling-graph-")); const scope = join(graph, "@earendil-works");
  const installedCoding = await realpath(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent"));
  const sources = {
    coding: installedCoding,
    ai: await realpath(join(dirname(installedCoding), "pi-ai")),
    core: await realpath(join(dirname(installedCoding), "pi-agent-core")),
  };
  const packages = { coding: join(scope, "pi-coding-agent"), ai: join(scope, "pi-ai"), core: join(scope, "pi-agent-core") };
  const files = {
    coding: ["package.json", "dist/cli.js", "dist/index.js", "dist/core/sdk.js", "dist/core/agent-session.js", "dist/core/model-runtime.js", "dist/core/resource-loader.js", "dist/core/settings-manager.js", "dist/core/session-manager.js", "dist/core/extensions/loader.js", "dist/core/extensions/runner.js", "dist/core/auth-storage.js"],
    ai: ["package.json", "dist/models.js", "dist/auth/resolve.js", "dist/api/openai-codex-responses.js", "dist/api/openai-responses-shared.js", "dist/providers/data/openai-codex.json"],
    core: ["package.json", "dist/agent.js", "dist/agent-loop.js"],
  } as const;
  for (const kind of ["coding", "ai", "core"] as const) {
    for (const file of files[kind]) {
      const target = join(packages[kind], file); await mkdir(dirname(target), { recursive: true }); await cp(join(sources[kind], file), target);
    }
  }
  await chmod(join(packages.coding, "dist/cli.js"), 0o755);
  return { graph, packages };
}

describe("v1 hardening procedures", () => {
  it("verifies the provenance-bound final-payload fixture set", async () => {
    const result = await execFileAsync(process.execPath, ["scripts/verify-pi-fixtures.mjs"], { cwd: process.cwd() });
    expect(result.stdout).toContain("openai-codex-responses/first-turn.json");
  });

  it("fails closed when an upgrade fixture has an unknown final-payload shape", async () => {
    const directory = await fixtureRoot(async (_manifest, root) => { await writeFile(join(root, paths[0][0]), JSON.stringify({ ...synthetic, reasoning: null })); });
    await rejectsFixture(directory, "unknown final-payload shape");
  });

  it.each([
    ["empty", async (manifest: Record<string, unknown>) => { manifest.fixtures = []; }, "exactly the seven"],
    ["reduced", async (manifest: Record<string, unknown>) => { (manifest.fixtures as unknown[]).pop(); }, "exactly the seven"],
    ["extra", async (manifest: Record<string, unknown>) => { (manifest.fixtures as object[]).push({ path: "openai-responses/extra.json", api: "openai-responses", provenance: "synthetic" }); }, "exactly the seven"],
    ["duplicate", async (manifest: Record<string, unknown>) => { (manifest.fixtures as object[]).splice(1, 1, (manifest.fixtures as object[])[0]!); }, "duplicated"],
    ["traversal", async (manifest: Record<string, unknown>) => { (manifest.fixtures as Array<Record<string, unknown>>)[0]!.path = "../openai-codex-responses/first-turn.json"; }, "authorized contained"],
    ["revision mismatch", async (manifest: Record<string, unknown>) => { (manifest.compatibility as Record<string, unknown>).upstreamCommit = "0".repeat(40); }, "upstream revision"],
    ["synthetic sensitive content", async (_manifest: Record<string, unknown>, directory: string) => { const value = JSON.parse(await readFile(join(directory, paths[0][0]), "utf8")); value.instructions = "sk-sensitive"; await writeFile(join(directory, paths[0][0]), JSON.stringify(value)); }, "allowlisted redaction"],
    ["captured provenance", async (manifest: Record<string, unknown>, directory: string) => { (manifest.fixtures as Array<Record<string, unknown>>)[0]!.provenance = "captured-sanitized"; await writeFile(join(directory, paths[0][0]), JSON.stringify({ ...synthetic, fixture_provenance: "captured and sanitized" })); }, "captured provenance"],
  ])("rejects %s fixture metadata", async (_name, mutate, message) => rejectsFixture(await fixtureRoot(mutate), message));

  it("rejects symlinked authorized fixture paths", async () => {
    const directory = await fixtureRoot(async (_manifest, root) => {
      const outside = await mkdtemp(join(tmpdir(), "pi-reap-fixture-outside-")); await writeFile(join(outside, "payload.json"), JSON.stringify(synthetic)); await unlink(join(root, paths[0][0]));
      await symlink(join(outside, "payload.json"), join(root, paths[0][0]));
    });
    await rejectsFixture(directory, "contained regular fixture");
  });

  it.each([
    ["raw tool output", async (root: string) => { const value = JSON.parse(await readFile(join(root, "openai-responses/tool-continuation.json"), "utf8")); value.input[0].output = "actual tool result"; await writeFile(join(root, "openai-responses/tool-continuation.json"), JSON.stringify(value)); }],
    ["ordinary text in an unknown field", async (root: string) => { const value = JSON.parse(await readFile(join(root, paths[0][0]), "utf8")); value.operator_note = "ordinary user text"; await writeFile(join(root, paths[0][0]), JSON.stringify(value)); }, "unknown, missing"],
    ["nested unknown field", async (root: string) => { const value = JSON.parse(await readFile(join(root, paths[0][0]), "utf8")); value.reasoning.private_detail = "ordinary text"; await writeFile(join(root, paths[0][0]), JSON.stringify(value)); }, "unknown, missing"],
    ["captured raw tool output", async (root: string, manifest: Record<string, unknown>) => { (manifest.fixtures as Array<Record<string, unknown>>)[5]!.provenance = "captured-sanitized"; const value = JSON.parse(await readFile(join(root, "openai-responses/tool-continuation.json"), "utf8")); value.fixture_provenance = "captured and sanitized; Pi 0.82.1; upstream cee5ff7520d8828bed9955ef00419e995d1f91e0"; value.input[0].output = "actual tool result"; await writeFile(join(root, "openai-responses/tool-continuation.json"), JSON.stringify(value)); }],
  ])("rejects %s under every provenance schema", async (_name, mutate, message = "allowlisted redaction") => {
    const directory = await fixtureRoot(async (manifest, root) => mutate(root, manifest)); await rejectsFixture(directory, message);
  });

  it("pins the authoritative release gate to PRs, immutable actions, and one local command", async () => {
    const workflow = await readFile(join(process.cwd(), ".github/workflows/release-gate.yml"), "utf8");
    const release = await readFile(join(process.cwd(), "docs/RELEASE.md"), "utf8");
    const releaseScript = await readFile(join(process.cwd(), "scripts/release-check.mjs"), "utf8");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain('branches: ["**"]');
    expect(workflow).toContain('tags: ["v*"]');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("- run: pnpm release:check");
    expect(workflow).not.toContain("- run: pnpm test");
    const pins = { "actions/checkout": ["11bd71901bbe5b1630ceea73d27597364c9af683", "v4.2.2"], "pnpm/action-setup": ["0ebf47130e4866e96fce0953f49152a61190b271", "v6.0.9"], "actions/setup-node": ["1d0ff469b7ec7b3cb9d8673fde0c81c44821de2a", "v4.2.0"] } as const;
    for (const [action, [sha, version]] of Object.entries(pins)) { expect(workflow).toContain(`${action}@${sha} # ${version}`); expect(release).toContain(sha); expect(release).toContain(version); }
    expect(workflow).not.toMatch(/uses: .+@v\d/);
    for (const command of ["fixtures:verify", "profile:verify", "build", "eval:build", "lint", "typecheck", "eval:typecheck", "eval:sample", "test", "rollback:check", "package:check"]) expect(releaseScript).toContain(`"${command}"`);
    expect(releaseScript).not.toContain('"release:check"');
  });

  it("validates an exact content-addressed prior artifact without mutating rollback state", async () => {
    const rollback = await execFileAsync(process.execPath, ["scripts/rollback-check.mjs", "--dry-run"], { cwd: process.cwd() });
    expect(rollback.stdout).toContain("verified exact synthetic-prior-artifact-record-v1");
    expect(rollback.stdout).toContain("no settings, package, tag, or release state was changed");
    const script = await readFile(join(process.cwd(), "scripts/rollback-check.mjs"), "utf8");
    const fixture = JSON.parse(await readFile(join(process.cwd(), "test/fixtures/rollback/prior-verified-artifact.json"), "utf8")) as RollbackFixture;
    expect(script).toContain('expectedBindingDigest = "377635d87dbe65f85ba67c621ca8b4f6d44fa9488efaf57d7b413ab5ca2b1411"');
    expect(script).toContain('expectedRecordDigest = "957383df7de96e2cbc83048647847877ade82cc69c6b24885ff9393f24aaa470"');
    expect(fixture.bindingDigest).toBe("377635d87dbe65f85ba67c621ca8b4f6d44fa9488efaf57d7b413ab5ca2b1411");
    expect(digest(fixture)).toBe("957383df7de96e2cbc83048647847877ade82cc69c6b24885ff9393f24aaa470");
  });

  it.each([
    ["package", (value: RollbackFixture) => { value.artifact.identity.buildFingerprint = "0".repeat(64); }],
    ["profile", (value: RollbackFixture) => { value.artifact.binding.capability.profileDigest = "0".repeat(64); }],
    ["source", (value: RollbackFixture) => { value.artifact.binding.admission.source.repositoryRevision = "other"; }],
    ["capability reference", (value: RollbackFixture) => { value.artifact.binding.admission.capabilityProfileId = "other"; }],
    ["catalog", (value: RollbackFixture) => { value.artifact.binding.match.modelCatalogDigest = "0".repeat(64); }],
    ["adapter", (value: RollbackFixture) => { value.artifact.binding.match.providerAdapterDigest = "0".repeat(64); }],
    ["Pi", (value: RollbackFixture) => { value.artifact.binding.match.piVersion = "0.82.2"; }],
  ])("rejects a mismatched prior %s binding", async (_name, mutate) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-reap-rollback-adversarial-"));
    await cp(join(process.cwd(), "test/fixtures/rollback"), directory, { recursive: true });
    const path = join(directory, "prior-verified-artifact.json"); const value = JSON.parse(await readFile(path, "utf8")); mutate(value); await writeFile(path, JSON.stringify(value));
    await expect(execFileAsync(process.execPath, ["scripts/rollback-check.mjs", "--dry-run"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_ROLLBACK_ROOT: directory } })).rejects.toBeDefined();
  });

  it("rejects an explicitly unverified prior record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-reap-rollback-unverified-"));
    await cp(join(process.cwd(), "test/fixtures/rollback"), directory, { recursive: true });
    const path = join(directory, "prior-verified-artifact.json"); const value = JSON.parse(await readFile(path, "utf8")); value.verification.status = "unverified"; await writeFile(path, JSON.stringify(value));
    await expect(execFileAsync(process.execPath, ["scripts/rollback-check.mjs", "--dry-run"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_ROLLBACK_ROOT: directory } })).rejects.toMatchObject({ stderr: expect.stringContaining("unverified") });
  });

  it("rejects the reviewer reproduction that recomputes a mutated combined binding", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-reap-rollback-recomputed-")); await cp(join(process.cwd(), "test/fixtures/rollback"), directory, { recursive: true });
    const path = join(directory, "prior-verified-artifact.json"); const value = JSON.parse(await readFile(path, "utf8")) as RollbackFixture;
    value.artifact.identity.sourceFingerprint = "0".repeat(64); rebindRollback(value); await writeFile(path, JSON.stringify(value));
    await expect(execFileAsync(process.execPath, ["scripts/rollback-check.mjs", "--dry-run"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_ROLLBACK_ROOT: directory } })).rejects.toMatchObject({ stderr: expect.stringContaining("not authorized by the release contract") });
  });

  it("rejects a replayed record and a mutable index authorization field", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-reap-rollback-replay-")); await cp(join(process.cwd(), "test/fixtures/rollback"), directory, { recursive: true });
    const path = join(directory, "prior-verified-artifact.json"); const value = JSON.parse(await readFile(path, "utf8")) as RollbackFixture;
    value.recordId = "synthetic-prior-artifact-record-v0"; value.verification.releaseSequence = 0; await writeFile(path, JSON.stringify(value));
    await expect(execFileAsync(process.execPath, ["scripts/rollback-check.mjs", "--dry-run"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_ROLLBACK_ROOT: directory } })).rejects.toMatchObject({ stderr: expect.stringContaining("replayed") });
    const indexPath = join(directory, "index.json"); const index = JSON.parse(await readFile(indexPath, "utf8")); index.recordDigest = digest(value); await writeFile(indexPath, JSON.stringify(index));
    await expect(execFileAsync(process.execPath, ["scripts/rollback-check.mjs", "--dry-run"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_ROLLBACK_ROOT: directory } })).rejects.toMatchObject({ stderr: expect.stringContaining("unknown or missing fields") });
  });

  it("rejects a missing prior verified artifact record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-reap-rollback-missing-")); await cp(join(process.cwd(), "test/fixtures/rollback"), directory, { recursive: true });
    await unlink(join(directory, "prior-verified-artifact.json"));
    await expect(execFileAsync(process.execPath, ["scripts/rollback-check.mjs", "--dry-run"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_ROLLBACK_ROOT: directory } })).rejects.toBeDefined();
  });

  it("declares a loadable public Pi package without claiming a release exists", async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as Record<string, unknown>;
    const release = await readFile(join(process.cwd(), "docs/RELEASE.md"), "utf8");
    expect(pkg.version).toBe("1.0.0"); expect(pkg.private).not.toBe(true);
    expect(pkg.keywords).toEqual(expect.arrayContaining(["pi-package"]));
    expect((pkg.pi as { extensions: string[] }).extensions).toEqual(["./src/index.ts"]);
    expect((pkg.peerDependencies as Record<string, string>)["@earendil-works/pi-coding-agent"]).toBe("0.82.1");
    expect((pkg.devDependencies as Record<string, string>)["@earendil-works/pi-coding-agent"]).toBe("0.82.1");
    expect(pkg.piReapCompatibility).toMatchObject({
      piExecutableSha256: "af302f231437eaf6f37691bce4b34234fcb626bcb5eb3910d4fc3f6519bf78ca",
      piRuntimeGraphSha256: "fe2469ef9584883f9ea8b36d7f13d55f907ec4fd904663d38c2978d107bd2bc3",
      piCatalogSha256: "c3313710bc6910e6bbcb06d5867247e97ec3fa6c2af9bc780f8a3eefb03e32e1",
    });
    expect(release).toContain("git:github.com/code4focus/pi-REAP@<reviewed-commit>");
    expect(release).toContain("No tag or published release is created");
    expect((pkg.files as string[])).toContain("profiles");
    expect((pkg.files as string[])).toContain("scripts/profile-check.mjs");
  });

  it("creates and inspects a real package whose built entry and packed profile commands execute", async () => {
    const packed = await execFileAsync("pnpm", ["package:check"], { cwd: process.cwd() });
    expect(packed.stdout).toContain("real pack/unpack");
    expect(packed.stdout).toContain("all packed profile commands passed");
  });

  it("rejects an incompatible clean package graph before importing the artifact", async () => {
    const graph = await fakePiGraph({ version: "0.82.2", complete: false });
    await expect(execFileAsync(process.execPath, ["scripts/package-check.mjs", "--dry-run"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_PACKAGE_GRAPH_ROOT: graph } })).rejects.toMatchObject({ stderr: expect.stringContaining("incompatible dependency") });
  });

  it("rejects absent transitive Pi packages and a same-version fabricated complete graph", async () => {
    const incomplete = await fakePiGraph({ version: "0.82.1", complete: false });
    await expect(execFileAsync(process.execPath, ["scripts/package-check.mjs", "--dry-run"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_PACKAGE_GRAPH_ROOT: incomplete } })).rejects.toMatchObject({ stderr: expect.stringContaining("absent or invalid") });
    const fabricated = await fakePiGraph({ version: "0.82.1", complete: true });
    await expect(execFileAsync(process.execPath, ["scripts/package-check.mjs", "--dry-run"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_PACKAGE_GRAPH_ROOT: fabricated } })).rejects.toMatchObject({ stderr: expect.stringContaining("fabricated") });
  });

  it("rejects a symlinked graph root and a substituted package escaping the graph", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-reap-symlinked-graph-")); const link = join(directory, "node_modules");
    await symlink(join(process.cwd(), "node_modules"), link, "dir");
    await expect(execFileAsync(process.execPath, ["scripts/package-check.mjs", "--dry-run"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_PACKAGE_GRAPH_ROOT: link } })).rejects.toMatchObject({ stderr: expect.stringContaining("root is symlinked") });
    const substituted = await mkdtemp(join(tmpdir(), "pi-reap-substituted-graph-")); await mkdir(join(substituted, "@earendil-works"), { recursive: true });
    await symlink(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent"), join(substituted, "@earendil-works/pi-coding-agent"), "dir");
    await expect(execFileAsync(process.execPath, ["scripts/package-check.mjs", "--dry-run"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_PACKAGE_GRAPH_ROOT: substituted } })).rejects.toMatchObject({ stderr: expect.stringContaining("escapes by symlink") });
  });

  it.each([
    ["@earendil-works/pi-ai", "ai"], ["@earendil-works/pi-agent-core", "core"],
  ] as const)("rejects an external substituted nested %s even when the exact sibling is valid", async (dependency, _kind) => {
    const { graph, packages } = await exactSiblingPiGraph();
    const nested = join(packages.coding, "node_modules", dependency); await mkdir(dirname(nested), { recursive: true });
    const installedCoding = await realpath(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent"));
    const external = await realpath(join(dirname(installedCoding), dependency.split("/").at(-1)!));
    await symlink(external, nested, "dir");
    await expect(execFileAsync(process.execPath, ["scripts/package-check.mjs", "--dry-run", "--graph-only"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_PACKAGE_GRAPH_ROOT: graph } })).rejects.toMatchObject({ stderr: expect.stringContaining("escapes by symlink") });
  });

  it.each([
    ["@earendil-works/pi-ai", "ai"], ["@earendil-works/pi-agent-core", "core"],
  ] as const)("rejects invalid nested same-version %s content instead of falling back to the valid sibling", async (dependency, kind) => {
    const { graph, packages } = await exactSiblingPiGraph();
    const nested = join(packages.coding, "node_modules", dependency); await mkdir(dirname(nested), { recursive: true }); await cp(packages[kind], nested, { recursive: true });
    const manifestPath = join(nested, "package.json"); const manifest = JSON.parse(await readFile(manifestPath, "utf8")); manifest.name = `${dependency}-substituted`; await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(execFileAsync(process.execPath, ["scripts/package-check.mjs", "--dry-run", "--graph-only"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_PACKAGE_GRAPH_ROOT: graph } })).rejects.toMatchObject({ stderr: expect.stringContaining("incompatible dependency") });
  });

  it("uses exact sibling dependencies only when both higher-priority nested paths are genuinely absent", async () => {
    const { graph } = await exactSiblingPiGraph();
    const result = await execFileAsync(process.execPath, ["scripts/package-check.mjs", "--dry-run", "--graph-only"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_PACKAGE_GRAPH_ROOT: graph } });
    expect(result.stdout).toContain("exact Node/Pi precedence");
  });

  it("ships only candidate profiles until qualification, approval, and an exact pin", async () => {
    const verify = await execFileAsync("pnpm", ["profile:verify"], { cwd: process.cwd() });
    const list = await execFileAsync("pnpm", ["profile:list"], { cwd: process.cwd() });
    const check = await execFileAsync("pnpm", ["profile:check", "--id", "openai-responses-candidate-r1"], { cwd: process.cwd() });
    expect(verify.stdout).toContain("profile verification passed");
    expect(list.stdout).toContain("candidate");
    expect(check.stdout).toContain("preserve-baseline");
  });

  it.each([
    ["source", "source authority"], ["identity", "identity conflict"], ["catalog digest", "catalog digest"],
  ])("rejects a %s profile conflict without pinning it", async (kind, message) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-reap-profile-adversarial-"));
    await cp(join(process.cwd(), "profiles"), directory, { recursive: true });
    const capabilityPath = join(directory, "capability", "openai-responses-candidate-r1.json");
    const capability = JSON.parse(await readFile(capabilityPath, "utf8"));
    if (kind === "source") capability.source.authority = "wrong";
    if (kind === "identity") capability.profileId = "other";
    if (kind === "catalog digest") capability.match.modelCatalogDigest = "stale";
    await writeFile(capabilityPath, JSON.stringify(capability));
    if (kind === "identity") {
      const indexPath = join(directory, "index.json"); const index = JSON.parse(await readFile(indexPath, "utf8"));
      index.profiles[0].capability.profileId = "other"; index.profiles[0].capability.profileDigest = digest(capability); await writeFile(indexPath, JSON.stringify(index));
    }
    await expect(execFileAsync(process.execPath, ["scripts/profile-check.mjs", "--verify"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_PROFILES_ROOT: directory } })).rejects.toMatchObject({ stderr: expect.stringContaining(message) });
  });

  it.each([
    ["unknown field", async (root: string) => { const path = join(root, "capability/openai-responses-candidate-r1.json"); const value = JSON.parse(await readFile(path, "utf8")); value.extra = true; await writeFile(path, JSON.stringify(value)); }, "unknown or missing fields"],
    ["old content digest", async (root: string) => { const path = join(root, "capability/openai-responses-candidate-r1.json"); const value = JSON.parse(await readFile(path, "utf8")); value.rungs[0].providerValue = "changed"; await writeFile(path, JSON.stringify(value)); }, "content mutation"],
    ["duplicate registry entry", async (root: string) => { const path = join(root, "index.json"); const value = JSON.parse(await readFile(path, "utf8")); value.profiles.push(value.profiles[0]); await writeFile(path, JSON.stringify(value)); }, "duplicate profile ID"],
    ["unindexed file", async (root: string) => { await writeFile(join(root, "capability/unindexed.json"), "{}"); }, "unindexed or missing files"],
    ["registry unknown field", async (root: string) => { const path = join(root, "index.json"); const value = JSON.parse(await readFile(path, "utf8")); value.extra = true; await writeFile(path, JSON.stringify(value)); }, "unknown or missing fields"],
  ])("rejects profile registry %s", async (_name, mutate, message) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-reap-profile-registry-")); await cp(join(process.cwd(), "profiles"), directory, { recursive: true }); await mutate(directory);
    await expect(execFileAsync(process.execPath, ["scripts/profile-check.mjs", "--verify"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_PROFILES_ROOT: directory } })).rejects.toMatchObject({ stderr: expect.stringContaining(message) });
  });

  it("rejects coordinated admission revision drift and source disagreement after content pins are recomputed", async () => {
    for (const kind of ["revision", "source"] as const) {
      const directory = await mkdtemp(join(tmpdir(), `pi-reap-profile-${kind}-`)); await cp(join(process.cwd(), "profiles"), directory, { recursive: true });
      const admissionPath = join(directory, "admission/openai-responses-candidate-r1.json"); const admission = JSON.parse(await readFile(admissionPath, "utf8"));
      const indexPath = join(directory, "index.json"); const index = JSON.parse(await readFile(indexPath, "utf8"));
      if (kind === "revision") { admission.profileRevision = "r2"; index.profiles[0].admission.profileRevision = "r2"; }
      else { admission.source.evidenceDigest = "8".repeat(64); index.profiles[0].admission.source.evidenceDigest = "8".repeat(64); }
      index.profiles[0].admission.profileDigest = digest(admission); await writeFile(admissionPath, JSON.stringify(admission)); await writeFile(indexPath, JSON.stringify(index));
      await expect(execFileAsync(process.execPath, ["scripts/profile-check.mjs", "--verify"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_PROFILES_ROOT: directory } })).rejects.toMatchObject({ stderr: expect.stringContaining(kind === "revision" ? "stale or uncoordinated revision" : "source disagreement") });
    }
  });

  it("rejects a coordinated provider/API mapping mutation against the pinned registry identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-reap-profile-mapping-")); await cp(join(process.cwd(), "profiles"), directory, { recursive: true });
    const capabilityPath = join(directory, "capability/openai-responses-candidate-r1.json"); const capability = JSON.parse(await readFile(capabilityPath, "utf8"));
    capability.match.api = "other-api";
    const indexPath = join(directory, "index.json"); const index = JSON.parse(await readFile(indexPath, "utf8")); index.profiles[0].capability.profileDigest = digest(capability);
    await writeFile(capabilityPath, JSON.stringify(capability)); await writeFile(indexPath, JSON.stringify(index));
    await expect(execFileAsync(process.execPath, ["scripts/profile-check.mjs", "--verify"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_PROFILES_ROOT: directory } })).rejects.toMatchObject({ stderr: expect.stringContaining("mapping conflict") });
  });

  it("rejects symlinked profile paths even when the target is valid JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-reap-profile-symlink-")); await cp(join(process.cwd(), "profiles"), directory, { recursive: true });
    const path = join(directory, "capability/openai-responses-candidate-r1.json"); const outside = join(await mkdtemp(join(tmpdir(), "pi-reap-profile-outside-")), "profile.json");
    await writeFile(outside, await readFile(path)); await unlink(path); await symlink(outside, path);
    await expect(execFileAsync(process.execPath, ["scripts/profile-check.mjs", "--verify"], { cwd: process.cwd(), env: { ...process.env, PI_REAP_PROFILES_ROOT: directory } })).rejects.toMatchObject({ stderr: expect.stringContaining("contained regular file") });
  });

  it("contains no developer-home absolute path literals in executable source or tests", async () => {
    for (const path of [
      "src", "eval/runner", "eval/test", "test", "scripts",
    ]) {
      const files = await collectFiles(join(process.cwd(), path));
      for (const file of files.filter((candidate) => /\.(?:[cm]?[jt]s|json)$/.test(candidate))) {
        expect(await readFile(file, "utf8"), file).not.toMatch(/\/Users\/[^/]+\//);
      }
    }
  });
});

async function collectFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? collectFiles(join(root, entry.name)) : [join(root, entry.name)]))).flat();
}
