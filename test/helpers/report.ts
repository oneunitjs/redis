import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Writes machine-readable certification evidence. Each layer produces its own
 * report file under `test/reports/<layer>/`.
 */
export interface ReportEntry {
  testId: string;
  module: string;
  scenario: string;
  status: "pass" | "fail" | "skip";
  durationMs: number;
  error?: string;
  evidence?: Record<string, unknown>;
}

export interface Report {
  layer: string;
  module: string;
  commitSha: string | undefined;
  packageVersion: string | undefined;
  nodeVersion: string;
  redisVersion?: string;
  topology?: string;
  environment: string;
  timestamp: string;
  durationMs: number;
  passed: number;
  failed: number;
  skipped: number;
  entries: ReportEntry[];
}

let reportDir = "test/reports";

export function setReportDir(dir: string): void {
  reportDir = dir;
}

export function writeReport(layer: string, report: Omit<Report, "passed" | "failed" | "skipped"> & { entries: ReportEntry[] }): string {
  const dir = join(reportDir, layer);
  mkdirSync(dir, { recursive: true });

  const passed = report.entries.filter((e) => e.status === "pass").length;
  const failed = report.entries.filter((e) => e.status === "fail").length;
  const skipped = report.entries.filter((e) => e.status === "skip").length;

  const full: Report = {
    ...report,
    passed,
    failed,
    skipped,
    nodeVersion: process.version,
    timestamp: new Date().toISOString(),
    durationMs: report.durationMs ?? 0,
  };

  const path = join(dir, `${report.module}.json`);
  writeFileSync(path, JSON.stringify(full, null, 2));
  return path;
}
