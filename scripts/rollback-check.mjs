const dryRun = process.argv.includes("--dry-run");
if (!dryRun) throw new Error("Rollback is an operator procedure. Use --dry-run locally; do not bypass mandatory or quality gates.");
console.log("rollback dry-run: select the prior verified artifact, rerun mandatory and quality gates, then publish only through the approved release process");
