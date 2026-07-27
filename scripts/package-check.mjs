import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

if (!process.argv.includes("--dry-run")) throw new Error("Package verification is local-only. Use --dry-run; this command does not publish.");
const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const fail = (message) => { throw new Error(`package contract failed: ${message}`); };
if (pkg.version !== "1.0.0" || pkg.private === true) fail("expected public 1.0.0 manifest");
if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes("pi-package")) fail("missing pi-package keyword");
if (!Array.isArray(pkg.pi?.extensions) || pkg.pi.extensions.length !== 1 || pkg.pi.extensions[0] !== "./src/index.ts") fail("missing explicit Pi extension entry");
if (pkg.peerDependencies?.["@earendil-works/pi-coding-agent"] !== "*" || pkg.devDependencies?.["@earendil-works/pi-coding-agent"] !== "0.82.1" || pkg.piReapCompatibility?.piCodingAgent !== "@earendil-works/pi-coding-agent@0.82.1") fail("Pi core peer or exact compatibility metadata is invalid");
for (const path of [pkg.main, pkg.types, pkg.exports?.["."]?.import, pkg.exports?.["."]?.types, ...pkg.pi.extensions]) { if (typeof path !== "string") fail("main, exports, types, or extension entry is missing"); await access(resolve(root, path)); }
await import(new URL("../dist/index.js", import.meta.url).href);
await promisify(execFile)("pnpm", ["pack", "--dry-run"], { cwd: root });
console.log("package dry-run: manifest, Pi entry, built entry, types, and pack contract passed");
