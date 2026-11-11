/**
 * @oneunit/redis production certification gate.
 *
 * Runs the hermetic certification test suite (test/layers) and writes
 * machine-readable evidence under test/reports/. Exits non-zero when any
 * release gate fails so CI can block a release.
 *
 * Usage:
 *   npx tsx scripts/certify.ts
 *
 * Requires a running Redis on 127.0.0.1:6379 (or REDIS_URL) and the
 * package dependencies to be installed (ioredis, bullmq).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();
const REPORT_DIR = join(REPO, "test", "reports");
const SUMMARY_PATH = join(REPORT_DIR, "test-summary.json");

function writeJSON(path: string, value: unknown): void {
  mkdirSync(join(REPORT_DIR), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function runTests(): { ok: boolean; summary: any } {
  let output = "";
  try {
    output = execFileSync(
      process.execPath,
      [
        join(REPO, "node_modules", ".bin", "vitest"),
        "run",
        "test/layers",
        "--reporter=json",
      ],
      {
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
        cwd: REPO,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error: any) {
    output = error.stdout?.toString() ?? "";
    if (error.stderr) output += "\n" + error.stderr.toString();
  }

  let summary: any = { files: 0, tests: 0, passed: 0, failed: 0, pending: 0, success: false };
  try {
    const json = JSON.parse(output);
    summary = {
      files: json.numTotalTestSuites ?? json.numTestFiles ?? 0,
      tests: json.numTotalTests ?? json.numTests ?? 0,
      passed: json.numPassedTests ?? json.passed ?? 0,
      failed: json.numFailedTests ?? json.failed ?? 0,
      pending: json.numPendingTests ?? json.pending ?? 0,
      duration: json.duration ?? 0,
      success: json.success ?? false,
    };
  } catch {
    summary = { files: 0, tests: 0, passed: 0, failed: -1, pending: 0, parseError: true, raw: output.slice(0, 2000) };
  }

  return { ok: summary.success === true && summary.tests > 0, summary };
}

function main(): void {
  const start = Date.now();
  const { ok, summary } = runTests();
  const duration = Date.now() - start;

  const report = {
    layer: "certification",
    packageVersion: JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version,
    nodeVersion: process.version,
    environment: process.env.CI ? "ci" : "local",
    timestamp: new Date().toISOString(),
    durationMs: duration,
    gate: ok ? "passed" : "failed",
    ...summary,
  };

  writeJSON(SUMMARY_PATH, report);

  console.log(JSON.stringify(report, null, 2));

  if (!ok) {
    console.error("CERTIFICATION GATE FAILED — release blocked.");
    process.exit(1);
  }

  console.log("CERTIFICATION GATE PASSED.");
}

main();
