#!/usr/bin/env node
/**
 * Offline preflight plus future-authorized capture/finalize/cleanup.
 * No command accepts a signing key, provider credential, prompt text, or catalog override.
 */
import { join, resolve } from "node:path";
import {
  asPostCaptureFailure, authorizationDigest, CaptureFailure, captureAuthorized, finalizePrivateCapture, preflight, privateReviewWorksheet,
  sanitizedDryRun, sha256, validatePrivateTasks,
  PreflightCapabilityError,
} from "../dist/eval/eval/runner/live-driver.js";
import { canonicalArtifactSha256 } from "../dist/eval/eval/runner/live-acceptance.js";
import {
  cleanupPrivateRoot, createPrivateRoot, loadInstalledPi, loadPrivateRoot, productionAdapterFactory,
  readPrivateJsonFile, validatePrivateTaskFile, validateProductionBuild, writeFailureReceipt, writePrivate,
} from "../dist/eval/eval/runner/live-production.js";

const args = process.argv.slice(2);
const command = args[0]?.startsWith("--") === false ? args[0] : "dry-run";
const value = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const repositoryRoot = resolve(".");
let privateRoot;

try {
  if (command === "cleanup") {
    const rootPath = value("--root"); if (!rootPath) throw new Error("missing cleanup root");
    cleanupPrivateRoot(rootPath);
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: "cleaned", rootHash: sha256(resolve(rootPath)) })}\n`);
  } else if (command === "finalize") {
    const rootPath = value("--root"); if (!rootPath) throw new Error("missing finalize root");
    privateRoot = loadPrivateRoot(rootPath);
    validateProductionBuild(repositoryRoot);
    const installed = loadInstalledPi();
    const tasks = readPrivateJsonFile(join(privateRoot.path, "tasks.json"), privateRoot, 65_536);
    const capture = readPrivateJsonFile(join(privateRoot.path, "capture.json"), privateRoot);
    const reviewPath = value("--review");
    let reviews = [];
    if (reviewPath) reviews = readPrivateJsonFile(resolve(reviewPath), privateRoot, 65_536);
    const artifact = finalizePrivateCapture(capture, tasks, installed.catalog, reviews);
    try {
      writePrivate(privateRoot, "unsigned-artifact.json", `${JSON.stringify(artifact)}\n`);
      process.stdout.write(`${JSON.stringify({ schemaVersion: 2, status: "unsigned", artifactSha256: canonicalArtifactSha256(artifact), trusted: false, rootHash: sha256(privateRoot.path) })}\n`);
    } catch (error) {
      throw asPostCaptureFailure(error);
    }
  } else {
    const tasksPath = value("--tasks"); if (!tasksPath) throw new Error("missing private tasks");
    const tasks = validatePrivateTaskFile(resolve(tasksPath), repositoryRoot); validatePrivateTasks(tasks);
    validateProductionBuild(repositoryRoot);
    const installed = loadInstalledPi();
    const execute = command === "capture";
    if (command !== "dry-run" && !execute) throw new Error("unknown command");
    const result = preflight(execute, value("--authorization-digest"), tasks, installed.catalog, installed.cachePrefixMeasurement);
    if (!execute) {
      process.stdout.write(`${JSON.stringify(sanitizedDryRun(result.calls, result.envelope, authorizationDigest(result.envelope), result.cachePrefixMeasurement))}\n`);
    } else {
      privateRoot = createPrivateRoot();
      const captured = await captureAuthorized(result.calls, tasks, productionAdapterFactory(installed, privateRoot, repositoryRoot));
      writePrivate(privateRoot, "tasks.json", `${JSON.stringify(tasks)}\n`);
      writePrivate(privateRoot, "capture.json", `${JSON.stringify({
        schemaVersion: 3, envelope: result.envelope, authorizationDigest: result.digest, calls: result.calls, captured,
        cachePrefixMeasurement: result.cachePrefixMeasurement,
      })}\n`);
      const worksheet = privateReviewWorksheet(captured, tasks);
      if (worksheet.length > 0) writePrivate(privateRoot, "review-required.json", `${JSON.stringify(worksheet, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: "captured", calls: captured.length, reviewRequired: worksheet.length, root: privateRoot.path, rootHash: sha256(privateRoot.path) })}\n`);
    }
  }
} catch (error) {
  if (privateRoot) {
    const failureCode = error instanceof CaptureFailure ? error.code : "driver_failed";
    const completedCalls = error instanceof CaptureFailure ? error.completedCalls : 0;
    const phase = error instanceof CaptureFailure ? error.phase : "capture";
    try { writeFailureReceipt(privateRoot, failureCode, completedCalls, phase); } catch { /* never replace the sanitized failure */ }
  }
  const capabilityCode = error instanceof PreflightCapabilityError ? `; code=${error.code}` : "";
  process.stderr.write(`live-acceptance driver failed${capabilityCode}; private evidence was preserved when available\n`);
  process.exitCode = 2;
}
