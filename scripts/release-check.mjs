const dryRun = process.argv.includes("--dry-run");
if (!dryRun) throw new Error("Release publication is intentionally external. Use --dry-run locally; signing and publication require an approved release environment.");
console.log("release dry-run: compatibility pin, fixture verification, build/typecheck/lint/test gates must pass before external signing or publication");
