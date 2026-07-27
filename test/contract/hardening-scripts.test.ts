import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
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
    expect(workflow).toContain("- run: pnpm release:check");
    expect(workflow).not.toContain("- run: pnpm test");
    const pins = { "actions/checkout": ["11bd71901bbe5b1630ceea73d27597364c9af683", "v4.2.2"], "pnpm/action-setup": ["0ebf47130e4866e96fce0953f49152a61190b271", "v6.0.9"], "actions/setup-node": ["1d0ff469b7ec7b3cb9d8673fde0c81c44821de2a", "v4.2.0"] } as const;
    for (const [action, [sha, version]] of Object.entries(pins)) { expect(workflow).toContain(`${action}@${sha} # ${version}`); expect(release).toContain(sha); expect(release).toContain(version); }
    expect(workflow).not.toMatch(/uses: .+@v\d/);
    for (const command of ["fixtures:verify", "build", "eval:build", "lint", "typecheck", "eval:typecheck", "eval:sample", "test", "rollback:check", "package:check"]) expect(releaseScript).toContain(`"${command}"`);
    expect(releaseScript).not.toContain('"release:check"');
  });

  it("exercises rollback only in its safe dry-run mode", async () => {
    const rollback = await execFileAsync(process.execPath, ["scripts/rollback-check.mjs", "--dry-run"], { cwd: process.cwd() });
    expect(rollback.stdout).toContain("rollback dry-run");
  });

  it("declares a loadable public Pi package without claiming a release exists", async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as Record<string, unknown>;
    const release = await readFile(join(process.cwd(), "docs/RELEASE.md"), "utf8");
    expect(pkg.version).toBe("1.0.0"); expect(pkg.private).not.toBe(true);
    expect(pkg.keywords).toEqual(expect.arrayContaining(["pi-package"]));
    expect((pkg.pi as { extensions: string[] }).extensions).toEqual(["./src/index.ts"]);
    expect((pkg.peerDependencies as Record<string, string>)["@earendil-works/pi-coding-agent"]).toBe("*");
    expect((pkg.devDependencies as Record<string, string>)["@earendil-works/pi-coding-agent"]).toBe("0.82.1");
    expect(release).toContain("git:github.com/code4focus/pi-REAP@<reviewed-commit>");
    expect(release).toContain("No tag or published release is created");
  });
});
