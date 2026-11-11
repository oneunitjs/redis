import { spawn } from "node:child_process";
import { join } from "node:path";

/**
 * Runs N independent Node processes executing the same script, each against its
 * own Redis database index. Used for distributed correctness tests (locks,
 * semaphores, leader election, rate limits shared across processes).
 *
 * Each process writes its own result JSON to `<tmpDir>/<index>.json`. The
 * harness reads all results back once every process has exited.
 */
export interface DistributedResult {
  index: number;
  ok: boolean;
  passed: number;
  failed: number;
  errors: string[];
  durationMs: number;
}

export interface DistributedOptions {
  /** Path to the test script (must accept --index and --redis-url). */
  script: string;
  /** Number of independent processes. */
  count: number;
  /** Base Redis URL; database index `index` is appended. */
  baseUrl: string;
  /** Per-process timeout in ms. */
  timeoutMs?: number;
  /** Temporary directory for per-process result files. */
  tmpDir: string;
}

/**
 * Spawns `count` independent processes and aggregates their results.
 */
export async function runDistributed(options: DistributedOptions): Promise<{
  results: DistributedResult[];
  passed: number;
  failed: number;
  invariantOk: boolean;
}> {
  const { script, count, baseUrl, tmpDir, timeoutMs = 60000 } = options;

  const processes: Promise<void>[] = [];
  for (let index = 0; index < count; index += 1) {
    const url = `${baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl}/${index}`;
    processes.push(
      new Promise<void>((resolve, reject) => {
        const proc = spawn(process.execPath, [script, "--index", String(index), "--redis-url", url], {
          stdio: ["ignore", "pipe", "pipe"],
          cwd: process.cwd(),
        });

        let stdout = "";
        let stderr = "";
        proc.stdout?.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        proc.stderr?.on("data", (chunk) => {
          stderr += chunk.toString();
        });

        const timer = setTimeout(() => {
          proc.kill("SIGTERM");
          reject(new Error(`distributed process ${index} timed out`));
        }, timeoutMs);

        proc.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            reject(new Error(`distributed process ${index} exited ${code}: ${stderr}`));
          } else {
            resolve();
          }
        });
      }),
    );
  }

  await Promise.all(processes);

  const results: DistributedResult[] = [];
  let passed = 0;
  let failed = 0;

  for (let index = 0; index < count; index += 1) {
    const resultPath = join(tmpDir, `${index}.json`);
    try {
      const text = await readFilePromise(resultPath);
      const parsed = JSON.parse(text) as DistributedResult;
      results.push(parsed);
      passed += parsed.passed;
      failed += parsed.failed;
    } catch {
      results.push({ index, ok: false, passed: 0, failed: 1, errors: [`missing result file ${resultPath}`], durationMs: 0 });
      failed += 1;
    }
  }

  results.sort((a, b) => a.index - b.index);
  const invariantOk = results.every((r) => r.ok && r.failed === 0);

  return { results, passed, failed, invariantOk };
}

function readFilePromise(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    import("node:fs/promises").then((fs) => {
      fs.readFile(path, "utf8").then(resolve, reject);
    }, reject);
  });
}
