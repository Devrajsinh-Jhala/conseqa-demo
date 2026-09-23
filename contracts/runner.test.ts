import assert from "node:assert/strict";
import test from "node:test";
import { createStoreCreditIssuedRunner } from "./runner.js";

const context = {
  intentId: "demo-intent",
  actionKey: "demo-action",
  providerCorrelationKey: "cq_demo_1",
  intent: { customerId: "cus_demo_8042", amountMinor: 2499, currency: "USD" },
  registeredAt: "2026-09-01T00:00:00.000Z",
  signal: new AbortController().signal,
  binding: { creditId: "credit_1", recovered: true },
};
const row = {
  id: "credit_1",
  customer_id: "cus_demo_8042",
  amount_minor: 2499,
  currency: "USD",
  status: "issued",
  correlation_key: "cq_demo_1",
};

test("real discovery callback uses an exact parameterized SELECT and never writes", async () => {
  const runner = createStoreCreditIssuedRunner(async (statement, values) => {
    assert.match(statement, /^select .*where correlation_key = \$1 limit 2$/);
    assert.deepEqual(values, [context.providerCorrelationKey]);
    return [{ id: "credit_1" }];
  });
  assert.deepEqual(await runner.discover(context), {
    kind: "found",
    binding: { creditId: "credit_1", recovered: true },
  });
});

test("zero and multiple candidates never auto-bind", async () => {
  assert.equal(
    (await createStoreCreditIssuedRunner(async () => []).discover(context))
      .kind,
    "not_found",
  );
  assert.equal(
    (
      await createStoreCreditIssuedRunner(async () => [
        { id: "1" },
        { id: "2" },
      ]).discover(context)
    ).kind,
    "ambiguous",
  );
  assert.deepEqual(
    await createStoreCreditIssuedRunner(async () => [{}]).discover(context),
    { kind: "error", reason: "Discovery schema mismatch", retryable: false },
  );
});

test("issued observations verify every expected field; a wrong amount is failed, not pending", async () => {
  const good = await createStoreCreditIssuedRunner(
    async (statement, values) => {
      assert.match(statement, /^select /);
      assert.match(statement, /where id = \$1/);
      assert.deepEqual(values, ["credit_1"]);
      return [row];
    },
  ).verify(context);
  assert.equal(good.kind, "observed");
  if (good.kind === "observed") assert.equal(good.verdict, "satisfied");
  for (const change of [
    { amount_minor: 2500 },
    { customer_id: "wrong" },
    { correlation_key: "wrong" },
    { status: "reversed" },
  ]) {
    const result = await createStoreCreditIssuedRunner(async () => [
      { ...row, ...change },
    ]).verify(context);
    assert.equal(result.kind, "observed");
    if (result.kind === "observed") assert.equal(result.verdict, "violated");
  }
});

test("pending stays pending; missing or malformed evidence cannot become a failed action", async () => {
  const pending = await createStoreCreditIssuedRunner(async () => [
    { ...row, status: "pending" },
  ]).verify(context);
  assert.equal(pending.kind, "observed");
  if (pending.kind === "observed") assert.equal(pending.verdict, "pending");
  for (const rows of [
    [],
    [{}],
    [{ ...row, amount_minor: "2499" }],
    [{ ...row, status: "new-provider-state" }],
  ]) {
    assert.equal(
      (await createStoreCreditIssuedRunner(async () => rows).verify(context))
        .kind,
      "inconclusive",
    );
  }
});

test("authentication/configuration errors stop retries without leaking provider messages", async () => {
  for (const code of ["28P01", "28000", "42501", "42P01", "42703"]) {
    const runner = createStoreCreditIssuedRunner(async () => {
      throw Object.assign(new Error("password=do-not-export"), { code });
    });
    const discovery = await runner.discover(context);
    const observation = await runner.verify(context);
    assert.equal(discovery.kind, "error");
    assert.equal(observation.kind, "inconclusive");
    if (discovery.kind === "error") assert.equal(discovery.retryable, false);
    if (observation.kind === "inconclusive")
      assert.equal(observation.retryable, false);
    assert.doesNotMatch(
      JSON.stringify([discovery, observation]),
      /do-not-export/,
    );
  }
});

test("transient read failures remain retryable and do not leak raw messages", async () => {
  const runner = createStoreCreditIssuedRunner(async () => {
    throw new Error("private-connection-details");
  });
  assert.deepEqual(await runner.verify(context), {
    kind: "inconclusive",
    reason: "Database read unavailable",
    retryable: true,
  });
});
