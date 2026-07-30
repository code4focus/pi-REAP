import { spawn } from "node:child_process";

if (!process.argv.includes("--dry-run")) throw new Error("Release publication is intentionally external. Use --dry-run locally; signing and publication require an approved release environment.");

/** Ordered local gates. This script never invokes release:check, avoiding test recursion. */
export const releaseGateCommands = Object.freeze([
  ["pnpm", ["fixtures:verify"]],
  ["pnpm", ["profile:verify"]],
  ["pnpm", ["build"]],
  ["pnpm", ["eval:build"]],
  ["pnpm", ["lint"]],
  ["pnpm", ["typecheck"]],
  ["pnpm", ["eval:typecheck"]],
  ["pnpm", ["eval:sample"]],
  ["pnpm", ["test"]],
  ["pnpm", ["rollback:check"]],
  ["pnpm", ["package:check"]],
]);

for (const [command, args] of releaseGateCommands) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", (code, signal) => code === 0 ? resolve(undefined) : reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code})`)));
  });
}
console.log("release dry-run: all mandatory local gates passed; signing, tagging, and publication remain external and unverified");
