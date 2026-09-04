# Your agent said it worked. Did it?

An agent writes a store credit to a real PostgreSQL database. The write commits.
The reply never gets back.

Now the agent is holding an error and no credit id, and it cannot tell you
whether the customer was paid. Retry and you might pay them twice. Give up and
you might strand them. **Both are guesses.**

This demo produces that failure for real — against a real database, over the
real network — and then answers the question without retrying anything.

It takes about fifteen seconds.

```bash
git clone https://github.com/Devrajsinh-Jhala/conseqa-demo
cd conseqa-demo
npm install
cp .env.example .env      # paste a PostgreSQL connection string
npm run demo
```

## What it prints

```
3. The agent issues a store credit — and the reply is lost
  ✓ intent recorded before the statement — durable, on disk
  ✓ correlation key cq_7d74eca0c99554e6712ad7ed
  · INSERT INTO conseqa_demo.store_credits … → ep-….neon.tech
  ! Connection terminated unexpectedly — the agent has an error and no credit id
  ! was the customer paid? The agent cannot tell. Retrying might pay them twice.

4. The runner asks the database
  · SELECT id FROM store_credits WHERE correlation_key = 'cq_7d74…' (read-only)
  · runner is searching the database for the row the agent never saw

5. Verdict
  action    CONFIRMED_EXECUTED
  outcome   SATISFIED
  credit    726b26c1-d443-4867-8a5d-e337c1cfb766  recovered=true
  checks    5 of 5 passed
    ✓ /status           issued
    ✓ /customer_id      cus_demo_8042
    ✓ /amount_minor     2499
    ✓ /currency         USD
    ✓ /correlation_key  cq_7d74eca0c99554e6712ad7ed

  The credit is really in your database.
```

The last line is the one that matters, and you can check it yourself. The demo
prints the exact `select` to run.

## The failure is produced, not simulated

This is the part worth reading the source for.

The agent's connection runs through a local TCP proxy ([`src/demo.ts`](src/demo.ts),
`startLossyProxy`). The proxy forwards the `INSERT` upstream, the database
executes and commits it, and then the proxy **drops the response and destroys
both sockets** before a byte of it reaches the client.

That is what a network does when it fails at the worst possible moment. Nothing
is stubbed, and no error is manufactured in the client library — the agent
catches a genuine socket failure.

TLS terminates at the database, so the proxy carries opaque bytes it cannot
read. It is only allowed to lose them.

## How the recovery works

Four things, in order:

1. **Before the write**, the SDK records the intended outcome to disk and issues
   a correlation key. In `required` mode the write does not begin until that has
   succeeded, so there is never an action with no record of what it was for.

2. **The write carries the key** — here in a column, and for an HTTP provider in
   metadata that comes back on every read. This is what makes a lost action
   findable afterwards *by identity*, rather than by guessing from timestamps
   and amounts.

3. **After the failure**, a runner inside your network reads the system of
   record and matches on that key. It is a separate process holding separate
   credentials.

4. **The verdict arrives with its evidence** — the fields that decided it, and
   whether each check passed.

## The verifier cannot write

Set `DATABASE_READ_URL` to a role that holds `SELECT` and nothing else:

```sql
create role conseqa_verifier login password '…';
grant usage on schema conseqa_demo to conseqa_verifier;
grant select on conseqa_demo.store_credits to conseqa_verifier;
```

Then "verification cannot cause the effect it is verifying" stops being a claim
about the code and becomes a permission the database enforces. The demo runs
without this and tells you it is doing so.

## Honest limits

- **The read path needs Neon.** Conseqa works against any PostgreSQL, but the
  verifier here runs inside a bundled contract, and a CommonJS driver cannot be
  bundled into one — so this demo reads over Neon's SQL-over-HTTP endpoint. A
  free Neon project takes about a minute and needs no card.
- **`DATABASE_URL` needs to create one table** the first time, namespaced under
  `conseqa_demo`. If the role cannot, the demo prints the SQL to run as owner
  and exits.
- **If the verdict is not `SATISFIED`**, that is a real reading of your
  database, not a broken demo. If the proxy cut the connection before the write
  committed, nothing committed — and Conseqa reports that honestly rather than
  inventing a verdict. Run it again.

## What this is a demo of

[Conseqa](https://conseqa.vercel.app) — outcome verification for agents that
change external systems. It records what an action was supposed to change, then
reads the provider afterwards and tells you what is actually true.

The packages this demo installs are public:

| Package | |
| --- | --- |
| [`@conseqa/sdk`](https://www.npmjs.com/package/@conseqa/sdk) | wraps the action, records intent, issues the key |
| [`@conseqa/runner`](https://www.npmjs.com/package/@conseqa/runner) | the private verifier, runs in your network |
| [`@conseqa/contracts`](https://www.npmjs.com/package/@conseqa/contracts) | the lifecycle model and reducer |
| [`@conseqa/verifiers`](https://www.npmjs.com/package/@conseqa/verifiers) | HTTP, PostgreSQL and custom checks |
| [`@conseqa/cli`](https://www.npmjs.com/package/@conseqa/cli) | builds and installs contract packages |

Connectors for [Stripe](https://www.npmjs.com/package/@conseqa/connector-stripe)
and [Razorpay](https://www.npmjs.com/package/@conseqa/connector-razorpay) ship
too, for the same recovery against a payment provider.

Questions, or want this run against your own stack?
[jhaladevrajsinh42@gmail.com](mailto:jhaladevrajsinh42@gmail.com)

Apache-2.0.
