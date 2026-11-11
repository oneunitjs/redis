import { test, afterEach } from "vitest";
import assert from "node:assert/strict";
import {
  createClient,
  shutdown,
  silentLogger,
} from "@oneunit/redis";
import {
  createRedisRefreshStore,
  createRedisSessionStore,
  createRedisStateStore,
} from "../../../src/features/stores.js";
import { spawnRedis } from "../../helpers/redis-spawn.js";

const instances: Array<{ stop: () => Promise<void> }> = [];
afterEach(async () => {
  for (const inst of instances.splice(0, instances.length)) {
    await inst.stop().catch(() => undefined);
  }
});

function stores(url: string) {
  const client = createClient({ url, maxRetriesPerRequest: null }, silentLogger);
  return {
    client,
    refresh: createRedisRefreshStore(client),
    session: createRedisSessionStore(client),
    state: createRedisStateStore(client),
  };
}

// --------------------------------------------------------------------------
// Auth / session / state stores
// --------------------------------------------------------------------------

test("AUTH-001 save and retrieve a refresh record with TTL", async () => {
  const inst = await spawnRedis(131);
  instances.push(inst);
  const { client, refresh } = stores(inst.url);
  try {
    const now = Date.now();
    await refresh.save({ id: "r1", userId: "u1", tokenHash: "hash1", expiresAt: now + 60000 });
    const record = await refresh.get("r1");
    assert.equal(record?.id, "r1");
    assert.equal(record?.userId, "u1");
    assert.equal(record?.tokenHash, "hash1");
    assert.ok(record!.expiresAt! > now);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("AUTH-002 consume is atomic: single successful consumer", async () => {
  const inst = await spawnRedis(132);
  instances.push(inst);
  const { client, refresh } = stores(inst.url);
  try {
    await refresh.save({ id: "c1", userId: "u1", tokenHash: "h", expiresAt: Date.now() + 60000 });
    const results = await Promise.all(Array.from({ length: 20 }, () => refresh.consume("c1")));
    const successes = results.filter((r) => r !== null);
    assert.equal(successes.length, 1, `expected exactly one consumer, got ${successes.length}`);
    assert.equal(await refresh.consume("c1"), null);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("AUTH-003 refresh record is not reusable after consume", async () => {
  const inst = await spawnRedis(133);
  instances.push(inst);
  const { client, refresh } = stores(inst.url);
  try {
    await refresh.save({ id: "r2", userId: "u1", tokenHash: "h", expiresAt: Date.now() + 60000 });
    assert.ok(await refresh.consume("r2") !== null);
    assert.equal(await refresh.consume("r2"), null);
    assert.equal(await refresh.get("r2"), null);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("AUTH-004 revoke makes a refresh record unusable", async () => {
  const inst = await spawnRedis(134);
  instances.push(inst);
  const { client, refresh } = stores(inst.url);
  try {
    await refresh.save({ id: "r3", userId: "u1", tokenHash: "h", expiresAt: Date.now() + 60000 });
    await refresh.revoke("r3");
    assert.equal(await refresh.get("r3"), null);
    assert.equal(await refresh.consume("r3"), null);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("AUTH-005 session version and bump", async () => {
  const inst = await spawnRedis(135);
  instances.push(inst);
  const { client, session } = stores(inst.url);
  try {
    assert.equal(await session.getVersion("u1"), 0);
    assert.equal(await session.bumpVersion("u1"), 1);
    assert.equal(await session.bumpVersion("u1"), 2);
    assert.equal(await session.getVersion("u1"), 2);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("AUTH-006 session revocation persists", async () => {
  const inst = await spawnRedis(136);
  instances.push(inst);
  const { client, session } = stores(inst.url);
  try {
    assert.equal(await session.isSessionRevoked("s1"), false);
    await session.revokeSession("s1");
    assert.equal(await session.isSessionRevoked("s1"), true);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("AUTH-007 state store set/get/consume", async () => {
  const inst = await spawnRedis(137);
  instances.push(inst);
  const { client, state } = stores(inst.url);
  try {
    await state.set("st:1", { foo: "bar" }, 60);
    const got = await state.get("st:1");
    assert.equal(got?.foo, "bar");
    const consumed = await state.consume("st:1");
    assert.equal(consumed?.foo, "bar");
    assert.equal(await state.get("st:1"), null);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("AUTH-008 state consume is atomic single use", async () => {
  const inst = await spawnRedis(138);
  instances.push(inst);
  const { client, state } = stores(inst.url);
  try {
    await state.set("stc:1", "secret", 60);
    const results = await Promise.all(Array.from({ length: 10 }, () => state.consume("stc:1")));
    const successes = results.filter((r) => r !== null && r !== undefined);
    assert.equal(successes.length, 1);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("AUTH-009 missing record returns null", async () => {
  const inst = await spawnRedis(139);
  instances.push(inst);
  const { client, refresh, state } = stores(inst.url);
  try {
    assert.equal(await refresh.get("nope"), null);
    assert.equal(await refresh.consume("nope"), null);
    assert.equal(await state.get("nope"), null);
    assert.equal(await state.consume("nope"), null);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});

test("AUTH-010 malformed record is handled safely", async () => {
  const inst = await spawnRedis(140);
  instances.push(inst);
  const { client, refresh } = stores(inst.url);
  try {
    await client.set("oneunit:auth:refresh:bad", "not-json");
    assert.equal(await refresh.get("bad"), null);
    assert.equal(await refresh.consume("bad"), null);
  } finally {
    await shutdown(client, silentLogger).catch(() => undefined);
  }
});
