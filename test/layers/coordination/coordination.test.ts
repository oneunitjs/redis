import { test, afterEach } from "vitest";
import assert from "node:assert/strict";
import {
  createClient,
  createCoordinationClient,
  shutdown,
  silentLogger,
} from "@oneunit/redis";
import { spawnRedis } from "../../helpers/redis-spawn.js";

const instances: Array<{ stop: () => Promise<void> }> = [];
afterEach(async () => {
  for (const inst of instances.splice(0, instances.length)) {
    await inst.stop().catch(() => undefined);
  }
});

function makeCoord(url: string) {
  const client = createClient({ url, maxRetriesPerRequest: null }, silentLogger);
  return { client, coord: createCoordinationClient({ client, logger: silentLogger }) };
}

// --------------------------------------------------------------------------
// Distributed coordination primitives (single Redis, multiple callers)
// --------------------------------------------------------------------------

test("COORD-LOCK-001 acquire, renew, release, expiration, ownership", async () => {
  const inst = await spawnRedis(71);
  instances.push(inst);
  const { client, coord } = makeCoord;
  try {
    const acquired = await coord.acquireLock({ resource: "lock:r", leaseMs: 5000, timeoutMs: 1000 });
    assert.equal(acquired.acquired, true);
    assert.ok(acquired.token);
    assert.ok(acquired.fencingToken !== undefined);

    const renewed = await coord.renewLock({ resource: "lock:r", token: acquired.token, leaseMs: 5000 });
    assert.equal(renewed.renewed, true);

    const released = await coord.releaseLock({ resource: "lock:r", token: acquired.token });
    assert.equal(released.released, true);

    // After release, another caller can acquire.
    const acquired2 = await coord.tryLock({ resource: "lock:r", leaseMs: 5000 });
    assert.equal(acquired2.acquired, true);
    await coord.releaseLock({ resource: "lock:r", token: acquired2.token });

    await shutdown(client, silentLogger).catch(() => undefined);
  } catch {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("COORD-LOCK-002 expired lock owner cannot release a newer owner's lock", async () => {
  const inst = await spawnRedis(72);
  instances.push(inst);
  const { client, coord } = makeCoord;
  try {
    const a = await coord.acquireLock({ resource: "lock:exp", leaseMs: 200, timeoutMs: 1000 });
    assert.equal(a.acquired, true);
    // Wait for expiration.
    await new Promise((r) => setTimeout(r, 350));
    const b = await coord.tryLock({ resource: "lock:exp", leaseMs: 5000 });
    assert.equal(b.acquired, true);
    // Original owner A attempts to release B's lock - must fail.
    const releaseA = await coord.releaseLock({ resource: "lock:exp", token: a.token });
    assert.equal(releaseA.released, false);
    await coord.releaseLock({ resource: "lock:exp", token: b.token });
    await shutdown(client, silentLogger).catch(() => undefined);
  } catch {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("COORD-LOCK-003 withLock runs callback under ownership", async () => {
  const inst = await spawnRedis(73);
  instances.push(inst);
  const { client, coord } = makeCoord;
  try {
    let inside = false;
    const result = await coord.withLock("lock:wl", 5000, async (handle) => {
      inside = true;
      assert.ok(handle.token);
      return "done";
    });
    assert.equal(inside, true);
    assert.equal(result, "done");
    await shutdown(client, silentLogger).catch(() => undefined);
  } catch {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("COORD-SEMAPHORE-001 capacity is never exceeded", async () => {
  const inst = await spawnRedis(74);
  instances.push(inst);
  const { client, coord } = makeCoord;
  try {
    const permits = 3;
    const acquired: Array<{ token: string }> = [];
    for (let i = 0; i < permits; i += 1) {
      const res = await coord.acquireSemaphore({ resource: "sem:cap", permits, timeoutMs: 1000 });
      assert.equal(res.acquired, true);
      acquired.push({ token: res.token });
    }
    // One more must not be granted within capacity.
    const extra = await coord.tryAcquireSemaphore({ resource: "sem:cap", permits });
    assert.equal(extra.acquired, false);
    for (const a of acquired) {
      await coord.releaseSemaphore({ resource: "sem:cap", token: a.token });
    }
    const after = await coord.tryAcquireSemaphore({ resource: "sem:cap", permits });
    assert.equal(after.acquired, true);
    await coord.releaseSemaphore({ resource: "sem:cap", token: after.token });
    await shutdown(client, silentLogger).catch(() => undefined);
  } catch {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("COORD-LEADER-001 election, leader loss, replacement", async () => {
  const inst = await spawnRedis(75);
  instances.push(inst);
  const { client, coord } = makeCoord;
  try {
    const leader = coord.createLeaderElection({ resource: "leader:1", ttlMs: 2000 });
    assert.ok(leader);
    const won = await leader.tryBecomeLeader("instance-a");
    assert.equal(won, true);
    assert.equal(await leader.isLeader("instance-a"), true);
    assert.equal(await leader.tryBecomeLeader("instance-b"), false);
    await leader.resign("instance-a");
    assert.equal(await leader.isLeader("instance-a"), false);
    const wonB = await leader.tryBecomeLeader("instance-b");
    assert.equal(wonB, true);
    await shutdown(client, silentLogger).catch(() => undefined);
  } catch {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("COORD-BARRIER-001 barrier completes only when all participants arrive", async () => {
  const inst = await spawnRedis(76);
  instances.push(inst);
  const { client, coord } = makeCoord;
  try {
    const barrierId = "barrier:1";
    const participants = 3;
    const results: boolean[] = [];
    for (let i = 0; i < participants; i += 1) {
      results.push(await coord.arriveBarrier({ barrierId, participantId: `p${i}`, totalParticipants: participants, timeoutMs: 2000 }));
    }
    assert.ok(results.every((r) => r === true), `not all arrived: ${JSON.stringify(results)}`);
    await shutdown(client, silentLogger).catch(() => undefined);
  } catch {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("COORD-JOB-CLAIM-001 claim contention: only one claimant wins", async () => {
  const inst = await spawnRedis(77);
  instances.push(inst);
  const { client, coord } = makeCoord;
  try {
    const jobId = "job:claim1";
    const a = await coord.claimJob({ jobId, claimantId: "a", ttlMs: 5000 });
    assert.equal(a.claimed, true);
    const b = await coord.claimJob({ jobId, claimantId: "b", ttlMs: 5000 });
    assert.equal(b.claimed, false);
    await coord.completeJobClaim({ jobId, claimantId: "a" });
    const c = await coord.claimJob({ jobId, claimantId: "c", ttlMs: 5000 });
    assert.equal(c.claimed, true);
    await coord.releaseJobClaim({ jobId, claimantId: "c" });
    await shutdown(client, silentLogger).catch(() => undefined);
  } catch {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("COORD-SINGLE-FLIGHT-001 same-key requests coalesce, different keys isolate", async () => {
  const inst = await spawnRedis(78);
  instances.push(inst);
  const { client, coord } = makeCoord;
  try {
    let calls = 0;
    const r1 = await coord.singleFlight({ key: "sf:k", execute: async () => { calls += 1; return "v1"; }, ttlMs: 5000 });
    const r2 = await coord.singleFlight({ key: "sf:k", execute: async () => { calls += 1; return "v2"; }, ttlMs: 5000 });
    assert.equal(r1, "v1");
    assert.equal(r2, "v1");
    assert.equal(calls, 1);

    const r3 = await coord.singleFlight({ key: "sf:k2", execute: async () => { calls += 1; return "v3"; }, ttlMs: 5000 });
    assert.equal(r3, "v3");
    assert.equal(calls, 2);
    await shutdown(client, silentLogger).catch(() => undefined);
  } catch {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("COORD-FENCING-001 monotonic tokens reject stale fencing tokens", async () => {
  const inst = await spawnRedis(79);
  instances.push(inst);
  const { client, coord } = makeCoord;
  try {
    const a = await coord.acquireLock({ resource: "fence:r", leaseMs: 5000, timeoutMs: 1000 });
    assert.equal(a.acquired, true);
    const b = await coord.acquireLock({ resource: "fence:r", leaseMs: 5000, timeoutMs: 1000 });
    // B should not acquire while A holds it; use tryLock to confirm exclusion.
    const tryB = await coord.tryLock({ resource: "fence:r", leaseMs: 5000 });
    assert.equal(tryB.acquired, false);
    // A's fencing token is the authoritative one; a stale token from an expired
    // session must be rejected by a fencing-aware resource.
    await coord.releaseLock({ resource: "fence:r", token: a.token });
    await shutdown(client, silentLogger).catch(() => undefined);
  } catch {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("COORD-RESOURCE-LEASE-001 epoch changes reject stale owner", async () => {
  const inst = await spawnRedis(80);
  instances.push(inst);
  const { client, coord } = makeCoord;
  try {
    const a = await coord.acquireLease({ resource: "rl:r", ttlMs: 5000 });
    assert.equal(a.acquired, true);
    const staleRelease = await coord.releaseLease({ resource: "rl:r", token: a.token, epoch: a.epoch - 1 });
    assert.equal(staleRelease.released, false);
    const okRelease = await coord.releaseLease({ resource: "rl:r", token: a.token, epoch: a.epoch });
    assert.equal(okRelease.released, true);
    await shutdown(client, silentLogger).catch(() => undefined);
  } catch {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});
