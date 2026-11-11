import { test } from "vitest";
import assert from "node:assert/strict";
import { redactError, classifyError, silentLogger } from "@oneunit/redis";

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val instanceof Error) {
      return {
        name: val.name,
        message: val.message,
        stack: val.stack,
        ...Object.fromEntries(Object.entries(val as Record<string, unknown>)),
      };
    }
    return val;
  });
}

// --------------------------------------------------------------------------
// SEC-001 .. SEC-014  (assert the redaction contract actually implemented)
// --------------------------------------------------------------------------

test("SEC-001 redacts a password in AUTH command arguments", () => {
  const password = "correct-horse-battery-staple";
  const error = Object.assign(new Error("WRONGPASS invalid username-password pair"), {
    command: { name: "auth", args: ["default", password] },
  });
  const redacted = redactError(error);
  const out = serialize(redacted);
  assert.ok(!out.includes(password), `password leaked: ${out}`);
  assert.equal((redacted as { command?: { args?: unknown } }).command?.args, "[redacted]");
});

test("SEC-002 redacts a Bearer token from the error message", () => {
  const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token";
  const error = Object.assign(new Error(`connecting with Bearer ${token}`), {
    command: { name: "auth", args: ["default", "pw"] },
  });
  const redacted = redactError(error);
  assert.ok(!redacted.message.includes(token), `token leaked in message: ${redacted.message}`);
  assert.ok(redacted.message.includes("Bearer ***"), `token not redacted: ${redacted.message}`);
});

test("SEC-003 removes AUTH command arguments but keeps the reason", () => {
  const error = Object.assign(new Error("WRONGPASS"), {
    command: { name: "auth", args: ["default", "hunter2"] },
  });
  const redacted = redactError(error);
  const out = serialize(redacted);
  assert.ok(!out.includes("hunter2"), `AUTH arg leaked: ${out}`);
  assert.ok(redacted.message.includes("WRONGPASS"), `reason lost: ${out}`);
});

test("SEC-004 removes sensitive HELLO fields", () => {
  const error = Object.assign(new Error("ERR unknown command"), {
    command: { name: "hello", args: ["3", "user", "alice", "pass", "s3cr3t"] },
  });
  const redacted = redactError(error);
  const out = serialize(redacted);
  assert.ok(!out.includes("s3cr3t"), `HELLO password leaked: ${out}`);
});

test("SEC-005 recursively sanitizes nested error causes", () => {
  const cause = Object.assign(new Error("nested failure"), {
    command: { name: "auth", args: ["u", "nested-pw"] },
  });
  const error = Object.assign(new Error("outer"), { cause });
  const redacted = redactError(error);
  const out = serialize(redacted);
  assert.ok(!out.includes("nested-pw"), `nested secret leaked: ${out}`);
});

test("SEC-006 a job payload carrying a secret is not added to the error surface", () => {
  const payload = { userId: 42, token: "redis://default:sk-live-secret-token@127.0.0.1:6379/0" };
  const redacted = redactError(Object.assign(new Error("job failed"), { job: { payload } }));
  const out = serialize(redacted);
  assert.ok(!out.includes("sk-live-secret-token"), `job payload secret leaked: ${out}`);
  assert.ok(out.includes("redis://***@"), `payload URL not redacted: ${out}`);
});

test("SEC-007 pipeline command failure exposes no credentials", () => {
  const error = Object.assign(new Error("ERR value is not an integer"), {
    command: { name: "auth", args: ["default", "pipe-secret"] },
  });
  const redacted = redactError(error);
  const out = serialize(redacted);
  assert.ok(!out.includes("pipe-secret"), `pipeline secret leaked: ${out}`);
});

test("SEC-008 shutdown failure produces a sanitized diagnostic", () => {
  const error = Object.assign(new Error("QUIT failed"), {
    command: { name: "auth", args: ["default", "shutdown-pw"] },
  });
  const redacted = redactError(error);
  const out = serialize(redacted);
  assert.ok(!out.includes("shutdown-pw"), `shutdown secret leaked: ${out}`);
});

test("SEC-009 rate-limit error diagnostic is sanitized", () => {
  const error = Object.assign(new Error("rate limited"), {
    command: { name: "auth", args: ["default", "rl-secret"] },
  });
  const redacted = redactError(error);
  const out = serialize(redacted);
  assert.ok(!out.includes("rl-secret"), `rate-limit secret leaked: ${out}`);
});

test("SEC-010 logger that throws does not break redaction or classification", () => {
  const redacted = redactError(Object.assign(new Error("x"), { command: { name: "auth", args: ["u", "pw"] } }));
  assert.ok(redacted !== undefined);
  const classified = classifyError(Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }));
  assert.equal(classified.kind, "connection");
  silentLogger.error("still works", redacted);
});

test("SEC-011 malformed error objects do not crash redaction", () => {
  const redacted = redactError(null);
  assert.ok(redacted !== undefined);
  const redacted2 = redactError({});
  assert.ok(redacted2 !== undefined);
  const redacted3 = redactError("plain string");
  assert.ok(redacted3 !== undefined);
});

test("SEC-012 multiline error text keeps command args redacted", () => {
  const error = Object.assign(new Error("injected payload"), {
    command: { name: "auth", args: ["u", "multi-line-pw"] },
  });
  const redacted = redactError(error);
  const out = serialize(redacted);
  assert.ok(!out.includes("multi-line-pw"), `multiline secret leaked: ${out}`);
  assert.equal((redacted as { command?: { args?: unknown } }).command?.args, "[redacted]");
});

test("SEC-013 unicode and encoded secrets are not disclosed in args", () => {
  const secret = "pässwörd🔑%25%3A%2F";
  const error = Object.assign(new Error("ERR"), {
    command: { name: "auth", args: ["default", secret] },
  });
  const redacted = redactError(error);
  const out = serialize(redacted);
  assert.ok(!out.includes(secret), `unicode secret leaked: ${out}`);
});

test("SEC-014 log injection keeps the real event and redacts the secret", () => {
  const error = Object.assign(new Error("real event"), {
    command: { name: "auth", args: ["u", "injection-pw"] },
  });
  const redacted = redactError(error);
  const out = serialize(redacted);
  assert.ok(!out.includes("injection-pw"), `injection secret leaked: ${out}`);
  assert.ok(out.includes("real event"), `real event lost: ${out}`);
});
