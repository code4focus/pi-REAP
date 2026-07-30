import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readVerifiedProfileRegistry } from "../src/distribution/profile-registry-contract.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const configuredRoot = resolve(process.env.PI_REAP_PROFILES_ROOT ?? resolve(packageRoot, "profiles"));
const { entries } = await readVerifiedProfileRegistry(configuredRoot);
const arg = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };

if (process.argv.includes("--list")) {
  for (const profile of entries) console.log(`${profile.id} ${profile.state} ${profile.capabilityDigest} ${profile.admissionDigest} ${profile.bindingDigest}`);
}
if (process.argv.includes("--check")) {
  const id = arg("--id"); const profile = entries.find((candidate) => candidate.id === id);
  if (!id || !profile) throw new Error("profile contract failed: unknown profile identity preserves baseline");
  const policy = profile.state === "candidate" ? "candidate inspect only; preserve-baseline" : profile.state === "qualified" ? "qualified shadow only with explicit approval; never enforce" : "pinned shadow; enforcement still requires qualification";
  console.log(`${profile.id}: ${policy}`);
}
if (!process.argv.includes("--list") && !process.argv.includes("--check")) console.log(`profile verification passed: ${entries.length} profile(s); candidate inspect-only, qualified shadow-only, pinned enforcement separately qualification-gated`);
