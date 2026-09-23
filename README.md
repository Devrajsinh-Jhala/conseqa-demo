# Your agent said it worked. Did it?

A scripted agent action writes a synthetic store-credit record to a real Neon
PostgreSQL database. A TCP proxy drops the reply. No LLM is called and no money
is moved.

Now the agent is holding an error and no credit id, and it cannot tell you
whether the record was written. Retrying could create a duplicate; giving up
could leave an accepted action unresolved.

This demo produces that failure for real — against a real database, over the
real network — and then answers the question without retrying anything.

The run usually takes about fifteen seconds **after setup**. Before starting,
install Node.js **22.13 or later** and create a Neon database. The writer needs
permission to create the demo schema/table on first run. The verifier uses
Neon's SQL-over-HTTP endpoint, so this particular example requires Neon.

```bash
git clone https://github.com/Devrajsinh-Jhala/conseqa-demo
cd conseqa-demo
npm install
cp .env.example .env      # edit with your Neon connection strings
npm run demo
```

On PowerShell, use `Copy-Item .env.example .env` to copy the configuration.
Never commit `.env` or paste database passwords into issues or chat.

## What it prints

```
3. The agent issues a store credit — and the reply is lost
  ✓ intent recorded before the statement — durable, on disk
  ✓ correlation key cq_7d74eca0c99554e6712ad7ed
  · INSERT INTO conseqa_demo.store_credits … → ep-….neon.tech
  ! Connection terminated unexpectedly — the agent has an error and no credit id
  ! was the synthetic credit recorded? The agent cannot tell. Retrying might duplicate it.

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
`startLossyProxy`). The proxy forwards database traffic upstream, then **drops
the next response and destroys both sockets** after the action starts. Its
encrypted traffic does not reveal whether the write committed. The later
database lookup establishes whether it did.

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
   findable afterwards _by identity_, rather than by guessing from timestamps
   and amounts.

3. **After the failure**, a runner inside your network reads the system of
   record and matches on that key. This compact demo embeds the runner in the
   same Node process, with verification callbacks in worker threads. Production
   deployments can run the runner as a separate service with separate credentials.

4. **The verdict arrives with its evidence** — the fields that decided it, and
   whether each check passed.

## Enforce read-only verification

Set `DATABASE_READ_URL` to a role that holds `SELECT` and nothing else:

```sql
create role conseqa_verifier login password '…';
grant usage on schema conseqa_demo to conseqa_verifier;
grant select on conseqa_demo.store_credits to conseqa_verifier;
```

Then "verification cannot cause the effect it is verifying" stops being a claim
about the code and becomes a permission the database enforces. Use a fresh
least-privilege role; do not grant it writer-role membership. The demo runs
without a separate role for convenience. Different connection strings alone
do not prove that the role is read-only, and the demo does not audit its grants.

## Honest limits

- **The read path needs Neon.** This example uses SQL-over-HTTP to work with the
  published 0.1.0 contract bundler. It is not a test of every PostgreSQL hosting
  provider or of the generic PostgreSQL connector.
- **`DATABASE_URL` needs to create one table** the first time, namespaced under
  `conseqa_demo`. If the role cannot, the demo prints the SQL to run as owner
  and exits.
- **Missing evidence means Unknown (`INCONCLUSIVE`).** It does not prove that
  nothing committed or that retrying is safe. The demo contract has a 20-second
  deadline; the console waits for that deadline plus probe and scheduling slack.
  A service interruption before a verdict is reported separately.
- **Unverified runs retain local evidence.** The console prints the temporary
  directory containing the SQLite event history and contract files. The runner
  is stopped; retaining those files does not keep verification running. Review
  the evidence before manually removing that directory. Verified runs clean up
  their local temporary files, but the demo database row remains.
- **There is no hosted dashboard sync.** This repository demonstrates the local
  protection and verification loop. It does not add an action to your hosted
  Conseqa workspace.

## Offline checks

```bash
npm ci
npm test
```

These checks need no database credentials. They type-check, run the real
discovery/verification callbacks with injected database responses, build the
contract, then evaluate data-only Contract Regression fixtures for exact
discovery, missing/duplicate evidence, changed amounts, authentication errors,
deadlines and artifact tampering. They test stored observations and engine
rules. The separate callback tests check parameterized read-only queries,
wrong-amount failures, ambiguous candidates, schema changes and sanitized
authentication errors. Neither suite runs an LLM or sends provider requests.
GitHub Actions runs the same checks on Windows and Linux.

## What this is a demo of

[Conseqa](https://conseqa.vercel.app) — outcome verification for agents that
change external systems. It records what an action was supposed to change, then
reads the provider afterwards and tells you what is actually true.

The packages this demo installs are public:

| Package                                                                  |                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------ |
| [`@conseqa/sdk`](https://www.npmjs.com/package/@conseqa/sdk)             | wraps the action, records intent, issues the key |
| [`@conseqa/runner`](https://www.npmjs.com/package/@conseqa/runner)       | the private verifier, runs in your network       |
| [`@conseqa/contracts`](https://www.npmjs.com/package/@conseqa/contracts) | the lifecycle model and reducer                  |
| [`@conseqa/verifiers`](https://www.npmjs.com/package/@conseqa/verifiers) | HTTP, PostgreSQL and custom checks               |
| [`@conseqa/cli`](https://www.npmjs.com/package/@conseqa/cli)             | builds and installs contract packages            |

Connectors for [Stripe](https://www.npmjs.com/package/@conseqa/connector-stripe)
and [Razorpay](https://www.npmjs.com/package/@conseqa/connector-razorpay) ship
too, for the same recovery against a payment provider.

Questions, or want this run against your own stack?
[jhaladevrajsinh42@gmail.com](mailto:jhaladevrajsinh42@gmail.com)

Apache-2.0.
