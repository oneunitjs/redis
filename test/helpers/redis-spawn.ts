import { spawn } from "node:child_process";
import { createClient } from "@oneunit/redis";
import { silentLogger } from "@oneunit/redis";

/**
 * Spawns an ephemeral, single-instance Redis server on a free port for a test
 * file. Each instance is torn down when `stop()` is called, so tests do not
 * collide on a shared `REDIS_URL` and can run against a clean database.
 *
 * The spawned server persists nothing to disk (`--save "" --appendonly no`)
 * and binds only to 127.0.0.1, so it is safe to use in CI and locally without
 * a running Redis service.
 */
export interface RedisInstance {
  port: number;
  url: string;
  stop: () => Promise<void>;
}

let nextPort = 6380;

export function spawnRedis(db = 0): Promise<RedisInstance> {
  return new Promise((resolve, reject) => {
    const port = nextPort += 1;
    const url = `redis://127.0.0.1:${port}/${db}`;

    const proc = spawn("redis-server", [
      "--port",
      String(port),
      "--bind",
      "127.0.0.1",
      "--save",
      "",
      "--appendonly",
      "no",
    ]);

    let stderr = "";
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        // Only reject if we never became ready; a clean exit after stop() is fine.
      }
    });

    let settled = false;
    const attempt = (tries = 30): void => {
      const client = createClient({ url, connectTimeout: 500, retryStrategy: () => null }, silentLogger);
      client
        .ping()
        .then(() => {
          if (settled) return;
          settled = true;
          resolve({
            port,
            url,
            stop: async () => {
              try {
                await client.flushdb();
              } catch {
                /* ignore */
              }
              try {
                await client.quit();
              } catch {
                /* ignore */
              }
              client.disconnect();
              proc.kill("SIGTERM");
            },
          });
        })
        .catch(() => {
          if (tries <= 0 || settled) {
            if (!settled) {
              proc.kill("SIGTERM");
              reject(new Error(`Redis on port ${port} did not become ready: ${stderr}`));
            }
            return;
          }
          setTimeout(() => attempt(tries - 1), 100);
        });
    };

    attempt();
  });
}

/**
 * Spawns several Redis instances on consecutive ports, useful for simulating
 * separate topologies in one test file.
 */
export async function spawnRedisCluster(count: number): Promise<RedisInstance[]> {
  const instances: RedisInstance[] = [];
  for (let i = 0; i < count; i += 1) {
    instances.push(await spawnRedis(i));
  }
  return instances;
}
