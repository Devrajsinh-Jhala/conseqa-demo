/**
 * Conseqa against a real PostgreSQL database, over the real network.
 *
 * A scripted action issues synthetic store credit. The INSERT may commit.
 * The proxy drops the reply, so the agent is left holding an error and no
 * credit id, with no way to say whether the customer was paid. Retrying might
 * pay them twice; giving up might strand them. Both are guesses.
 *
 * Conseqa reads the database and answers the question, without writing
 * anything and without retrying.
 *
 * The lost reply is not faked in the client library. The agent's connection
 * runs through a local TCP proxy that forwards the statement upstream and then
 * drops the response and destroys the socket, which is what a network does when
 * it fails at the worst possible moment. Only the later read establishes
 * whether the write actually committed.
 *
 *   npm install && npm run demo
 */
import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createRunnerApp, type RunnerConfig } from "@conseqa/runner";
import { Conseqa, loadClientContractPackage } from "@conseqa/sdk";
import type {
  ContractManifest,
  JsonObject,
  OutcomeContract,
} from "@conseqa/contracts";
import pg from "pg";

// The runner logs every sidecar request at info level. Correct in production,
// ruinous here, where it would bury the ten lines that carry the story.
process.env.NODE_ENV ??= "test";

// node:sqlite announces itself as experimental and pg warns about a future
// sslmode change. Neither is about this demo.
process.removeAllListeners("warning");
process.on("warning", (warning: Error) => {
  if (/sslmode|SQLite is an experimental/i.test(warning.message)) return;
  console.warn(warning.message);
});

const LOOPBACK = "127.0.0.1";
const ADMIN_TOKEN = "conseqa-demo-admin-token-32-byte";
const SIDECAR_TOKEN = "conseqa-demo-sidecar-token-32-by";
const CUSTOMER_ID = "cus_demo_8042";
const AMOUNT_MINOR = 2_499;
const CURRENCY = "USD";
const TABLE = "conseqa_demo.store_credits";

const dim = (t: string) => `[2m${t}[0m`;
const bold = (t: string) => `[1m${t}[0m`;
const green = (t: string) => `[32m${t}[0m`;
const amber = (t: string) => `[33m${t}[0m`;

const step = (t: string) => console.log(`\n${bold(t)}`);
const ok = (t: string) => console.log(`  ${green("✓")} ${t}`);
const warn = (t: string) => console.log(`  ${amber("!")} ${t}`);
const info = (t: string) => console.log(`  ${dim("·")} ${dim(t)}`);

/** Reads .env if present. Anything already in the environment wins. */
async function loadEnvironment(): Promise<void> {
  const file = path.resolve(import.meta.dirname, "..", ".env");
  const text = await readFile(file, "utf8").catch(() => "");
  for (const line of text.split(/\r?\n/)) {
    if (!/^[A-Z][A-Z0-9_]*=/.test(line)) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index);
    if (process.env[key] !== undefined) continue;
    process.env[key] = line.slice(index + 1).replace(/^["']|["']$/g, "");
  }
}

/**
 * Forwards the agent's connection upstream byte for byte. Once armed, the next
 * thing the database sends is dropped and both sockets are destroyed. Opaque
 * bytes cannot establish whether the transaction committed; discovery does.
 *
 * TLS runs end to end between the agent and the database, so this proxy cannot
 * read a single byte of what it carries. It is only allowed to lose it.
 */
function startLossyProxy(upstreamHost: string, upstreamPort: number) {
  let armed = false;
  let dropped = false;
  const sockets = new Set<net.Socket>();

  const server = net.createServer((client) => {
    const upstream = net.connect(upstreamPort, upstreamHost);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    }
    const teardown = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", teardown);
    upstream.on("error", teardown);
    client.on("data", (chunk) => upstream.write(chunk));
    upstream.on("data", (chunk) => {
      if (armed) {
        dropped = true;
        armed = false;
        teardown();
        return;
      }
      client.write(chunk);
    });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });

  return {
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, LOOPBACK, () =>
          resolve((server.address() as net.AddressInfo).port),
        );
      }),
    arm: () => {
      armed = true;
    },
    get didDrop() {
      return dropped;
    },
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface StoredIntentResponse {
  registration: { intentId: string; providerCorrelationKey: string };
  lifecycle: {
    actionState: string;
    outcomeState: string;
    binding: JsonObject | null;
    checks: readonly {
      id: string;
      passed: boolean;
      expected?: unknown;
      observed?: unknown;
    }[];
  };
}

async function builtArtifactPayload(directory: string) {
  const manifest = JSON.parse(
    await readFile(path.join(directory, "conseqa.manifest.json"), "utf8"),
  ) as ContractManifest;
  const fileNames = new Set([
    "conseqa.manifest.json",
    manifest.clientBundle,
    manifest.runnerBundle,
    ...manifest.contracts.flatMap((entry) => Object.values(entry.schemas)),
  ]);
  const files = Object.fromEntries(
    await Promise.all(
      [...fileNames].map(
        async (name) =>
          [
            name,
            (await readFile(path.join(directory, name))).toString("base64"),
          ] as const,
      ),
    ),
  );
  return { manifest, files };
}

async function restoreWritePermissions(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await restoreWritePermissions(target);
    else await chmod(target, 0o600);
  }
}

async function waitForTerminal(
  origin: string,
  intentId: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let seen = "";
  while (Date.now() < deadline) {
    const response = await fetch(
      `${origin}/v1/intents/${encodeURIComponent(intentId)}`,
      {
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(5_000, deadline - Date.now())),
        ),
        headers: { authorization: `Bearer ${SIDECAR_TOKEN}` },
      },
    );
    if (!response.ok)
      throw new Error(`Runner intent lookup failed with ${response.status}`);
    const intent = (await response.json()) as StoredIntentResponse;
    if (intent.lifecycle.outcomeState !== seen) {
      if (intent.lifecycle.outcomeState === "DISCOVERING") {
        info(
          "runner is searching the database for the row the agent never saw",
        );
      }
      seen = intent.lifecycle.outcomeState;
    }
    if (
      ["SATISFIED", "VIOLATED", "INCONCLUSIVE", "TIMED_OUT"].includes(
        intent.lifecycle.outcomeState,
      )
    ) {
      return intent;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

function exitWithSetupHelp(): never {
  console.error(
    [
      "",
      `  ${amber("DATABASE_URL is not set.")}`,
      "",
      "  This demo needs a PostgreSQL database it can write one row to.",
      "  Neon's free tier works and asks for no card:",
      "",
      "    1. https://neon.tech  ->  create a project",
      "    2. Copy the connection string",
      "    3. cp .env.example .env   and paste it in",
      "",
      "  Nothing else is created, and the one table it uses is namespaced",
      "  under conseqa_demo.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

async function main(): Promise<void> {
  await loadEnvironment();
  console.log(`\n${bold("Conseqa · live PostgreSQL demo")}`);

  const writeUrl = process.env.DATABASE_URL?.trim();
  if (!writeUrl) exitWithSetupHelp();
  const readUrl = process.env.DATABASE_READ_URL?.trim() || writeUrl;
  process.env.CONSEQA_DEMO_READ_URL = readUrl;

  let parsed: URL;
  try {
    parsed = new URL(writeUrl);
  } catch {
    console.error(
      "DATABASE_URL is not a valid connection URL; its value has not been logged.",
    );
    process.exitCode = 1;
    return;
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname.endsWith(".neon.tech")
  ) {
    console.error(
      [
        "",
        `  ${amber("This demo currently requires a Neon database.")}`,
        "",
        "  The verifier runs inside a bundled contract, and a CommonJS driver",
        "  cannot be bundled into it, so it reads over Neon's SQL-over-HTTP",
        "  endpoint. Any Postgres works with Conseqa itself; only this demo's",
        "  read path is Neon-specific today.",
        "",
        "  A free Neon project takes about a minute: https://neon.tech",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  step("1. Prepare a table to write to");
  const setupPool = new pg.Pool({
    connectionString: writeUrl,
    max: 2,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
  });
  setupPool.on("error", () => {});
  // A role that can already use the table does not need to create it. Roles
  // scoped tightly enough to be worth verifying often cannot create anything,
  // which is the point of the product and should not block its own demo.
  const tableUsable = await setupPool
    .query(`select 1 from ${TABLE} limit 1`)
    .then(() => true)
    .catch(() => false);
  if (tableUsable) {
    ok(`${TABLE} already exists`);
  } else {
    try {
      await setupPool.query("create schema if not exists conseqa_demo");
      await setupPool.query(`create table if not exists ${TABLE} (
        id uuid primary key default gen_random_uuid(),
        customer_id text not null,
        amount_minor integer not null check (amount_minor > 0),
        currency text not null,
        status text not null default 'issued',
        correlation_key text not null unique,
        created_at timestamptz not null default now())`);
      ok(`${TABLE} created`);
    } catch (error) {
      console.error(
        [
          "",
          `  ${amber("Could not create the demo table:")} ${(error as Error).message}`,
          "",
          "  The role in DATABASE_URL cannot create it, and it does not exist yet.",
          "  Either point DATABASE_URL at a role that can, or run this once as",
          "  the database owner:",
          "",
          "    create schema if not exists conseqa_demo;",
          `    create table ${TABLE} (`,
          "      id uuid primary key default gen_random_uuid(),",
          "      customer_id text not null,",
          "      amount_minor integer not null check (amount_minor > 0),",
          "      currency text not null,",
          "      status text not null default 'issued',",
          "      correlation_key text not null unique,",
          "      created_at timestamptz not null default now());",
          "",
        ].join("\n"),
      );
      await setupPool.end();
      process.exit(1);
    }
  }

  if (readUrl === writeUrl) {
    info(
      "verifier is using the same role as the agent, because DATABASE_READ_URL is unset",
    );
    info(
      "in production it would hold SELECT and nothing else - see the README",
    );
  } else {
    info(
      "verifier is using a separate connection string; its role permissions are not verified",
    );
  }

  const proxy = startLossyProxy(parsed.hostname, Number(parsed.port || 5432));
  const proxyPort = await proxy.listen();
  ok(`lossy proxy on ${LOOPBACK}:${proxyPort} → ${parsed.hostname}`);

  const scratch = await mkdtemp(path.join(tmpdir(), "conseqa-demo-"));
  const contractsDirectory = path.join(scratch, "contracts");
  const spoolDirectory = path.join(scratch, "spool");
  await mkdir(contractsDirectory, { recursive: true });
  await mkdir(spoolDirectory, { recursive: true });
  const config: RunnerConfig = {
    host: LOOPBACK,
    port: 0,
    databasePath: path.join(scratch, "runner.sqlite"),
    contractsDirectory,
    spoolDirectory,
    spoolQuotaBytes: 100 * 1_024 * 1_024,
    adminToken: ADMIN_TOKEN,
    sidecarToken: SIDECAR_TOKEN,
    allowRemoteAdmin: false,
    schedulerConcurrency: 4,
    verifierTimeoutMs: 10_000,
    heartbeatIntervalMs: 30_000,
    runtimeInstanceTtlMs: 90_000,
  };
  let runner: Awaited<ReturnType<typeof createRunnerApp>> | undefined;
  let verified = false;
  let conseqa: Conseqa | undefined;
  const agent = new pg.Client({
    host: LOOPBACK,
    port: proxyPort,
    user: parsed.username,
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.slice(1),
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
    // TLS still terminates at the database: the proxy carries opaque bytes.
    ssl: { servername: parsed.hostname },
  });
  // The proxy destroys this connection on purpose. Without a listener, pg
  // re-emits the socket failure as an unhandled 'error' event.
  agent.on("error", () => {});

  try {
    step("2. Start the private runner");
    runner = await createRunnerApp(config);
    const origin = await runner.app.listen({ host: LOOPBACK, port: 0 });
    ok(`runner on ${origin} ${dim("(loopback only)")}`);

    const packageDirectory = path.resolve(
      import.meta.dirname,
      "..",
      "dist",
      "conseqa",
    );
    const artifact = await builtArtifactPayload(packageDirectory);
    const schedule = artifact.manifest.contracts.find(
      (entry) => entry.name === "store.credit.issued" && entry.version === 1,
    )?.verification;
    if (!schedule)
      throw new Error("The built package is missing the store-credit schedule");
    // Allow the contract deadline, one in-flight probe, and scheduler slack.
    // Deriving this from the installed manifest keeps the CLI and runner aligned.
    const verificationWaitMs =
      schedule.deadlineMs + config.verifierTimeoutMs + 5_000;
    const install = await fetch(`${origin}/v1/contracts/install`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ artifact: { ...artifact, encoding: "base64" } }),
    });
    if (!install.ok)
      throw new Error(`Contract installation failed: ${await install.text()}`);
    const installed = (await install.json()) as {
      buildHash: string;
      runtime?: readonly { loaded?: boolean; error?: string }[];
    };
    const runtime = installed.runtime?.[0];
    if (!runtime?.loaded) {
      throw new Error(
        `Runner runtime did not load: ${runtime?.error ?? "unknown"}`,
      );
    }
    ok(`contract installed · build ${installed.buildHash.slice(0, 12)}`);

    const registry = await loadClientContractPackage({
      directory: packageDirectory,
    });
    const contract = registry.get("store.credit.issued", 1) as OutcomeContract<
      JsonObject,
      JsonObject,
      JsonObject
    >;
    conseqa = new Conseqa({
      contractRegistry: registry,
      runnerUrl: origin,
      sidecarToken: SIDECAR_TOKEN,
    });

    step("3. The agent issues a store credit — and the reply is lost");
    await agent.connect();
    let key = "";
    let agentError: unknown;
    try {
      await conseqa.protect(contract, {
        actionKey: `store_credit_${CUSTOMER_ID}_${Date.now()}`,
        protectionMode: "required",
        intent: {
          customerId: CUSTOMER_ID,
          amountMinor: AMOUNT_MINOR,
          currency: CURRENCY,
        },
        async execute({ providerCorrelationKey }) {
          key = providerCorrelationKey;
          ok(
            `intent recorded before the statement ${dim("— durable, on disk")}`,
          );
          ok(`correlation key ${bold(providerCorrelationKey)}`);
          info(`INSERT INTO ${TABLE} … → ${parsed.hostname}`);
          // From here the network is hostile: the proxy destroys the next
          // response. A later read must establish whether the write committed.
          proxy.arm();
          const result = await agent.query<{ id: string }>(
            `insert into ${TABLE} (customer_id, amount_minor, currency, correlation_key)
             values ($1, $2, $3, $4) returning id`,
            [CUSTOMER_ID, AMOUNT_MINOR, CURRENCY, providerCorrelationKey],
          );
          return { id: result.rows[0]?.id } as JsonObject;
        },
      });
    } catch (error) {
      agentError = error;
    }
    if (agentError === undefined) {
      throw new Error(
        "The reply was not lost — the demo did not exercise its own premise",
      );
    }
    if (!proxy.didDrop)
      warn("the proxy never dropped a packet; the failure came from elsewhere");
    warn(
      `${(agentError as Error).message} — the agent has an error and no credit id`,
    );
    warn(
      "was the synthetic credit recorded? The agent cannot tell. Retrying might duplicate it.",
    );

    step("4. The runner asks the database");
    const list = await fetch(`${origin}/v1/intents?limit=1`, {
      signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${SIDECAR_TOKEN}` },
    });
    if (!list.ok)
      throw new Error(`Runner intent listing failed with ${list.status}`);
    const intents = (await list.json()) as { items: StoredIntentResponse[] };
    const registered = intents.items[0];
    if (!registered)
      throw new Error("Runner did not durably register the intent");
    info(
      `SELECT id FROM store_credits WHERE correlation_key = '${key}' ${dim("(read-only)")}`,
    );
    const settled = await waitForTerminal(
      origin,
      registered.registration.intentId,
      verificationWaitMs,
    );

    step("5. Verdict");
    if (!settled) {
      warn(
        "Demo interrupted — verification did not finish within the bounded wait; no terminal verdict is available",
      );
      info(
        "This does not prove that the write failed or that it is safe to retry.",
      );
      info(`Check the row by correlation key: ${key}`);
      process.exitCode = 1;
      return;
    }
    const binding = settled.lifecycle.binding as {
      creditId?: string;
      recovered?: boolean;
    } | null;
    console.log(`  action    ${bold(settled.lifecycle.actionState)}`);
    console.log(`  outcome   ${bold(settled.lifecycle.outcomeState)}`);
    if (binding?.creditId) {
      console.log(
        `  credit    ${bold(binding.creditId)} ${dim(`recovered=${binding.recovered}`)}`,
      );
    }
    const passed = settled.lifecycle.checks.filter((c) => c.passed).length;
    console.log(
      `  checks    ${passed} of ${settled.lifecycle.checks.length} passed`,
    );
    for (const check of settled.lifecycle.checks) {
      const mark = check.passed ? green("✓") : amber("✕");
      console.log(
        `    ${mark} ${check.id} ${dim(String(check.observed ?? ""))}`,
      );
    }

    if (settled.lifecycle.outcomeState === "SATISFIED" && binding?.creditId) {
      const row = await setupPool.query(
        `select id::text as id, customer_id, amount_minor, currency, status, created_at
           from ${TABLE} where id = $1`,
        [binding.creditId],
      );
      console.log(`\n  ${green("The credit is really in your database:")}`);
      console.log(`  ${dim(JSON.stringify(row.rows[0]))}`);
      console.log(
        [
          "",
          "  The agent never learned that. Conseqa did, by reading the row the",
          "  agent's own statement wrote, matched on a key issued before it was sent.",
          "",
          `  ${dim(`Check it yourself: select * from ${TABLE} where correlation_key = '${key}';`)}`,
          "",
        ].join("\n"),
      );
      verified = true;
    } else {
      if (settled.lifecycle.outcomeState === "INCONCLUSIVE") {
        warn(
          "Unknown — available evidence could not establish the intended outcome.",
        );
        info(
          "Missing evidence does not prove non-execution or make retrying safe.",
        );
      } else {
        info(
          "The stored outcome and checks above explain why this action was not verified.",
        );
      }
      process.exitCode = 1;
    }
  } finally {
    await proxy.close().catch(() => {});
    await agent.end().catch(() => {});
    await conseqa?.close();
    await runner?.app.close().catch(() => {});
    await setupPool.end().catch(() => {});
    if (verified) {
      await restoreWritePermissions(contractsDirectory).catch(() => {});
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    } else {
      info(`Local evidence retained at ${scratch}`);
      info(
        "The runner has stopped. Its SQLite history can be inspected; no automatic retry is scheduled.",
      );
    }
  }
}

await main();
