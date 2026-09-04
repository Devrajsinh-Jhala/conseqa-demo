import { neon } from "@neondatabase/serverless";
import { evaluatePredicates } from "@conseqa/verifiers";
import type { JsonPredicate } from "@conseqa/verifiers";
import type { DiscoveryContext, JsonObject, VerificationContext } from "@conseqa/contracts";

const TABLE = "conseqa_demo.store_credits";

/**
 * Reads over Neon's SQL-over-HTTP endpoint rather than through `pg`.
 *
 * The contract bundle is ESM and is loaded by a worker thread from a directory
 * with no node_modules, so a CommonJS driver cannot be used here: `pg` fails to
 * bundle with "Dynamic require of events is not supported", and marking it
 * external only moves the failure to resolution time.
 *
 * The read-only guarantee therefore does not come from BEGIN READ ONLY, which a
 * single HTTP request cannot hold. It comes from the grant: the role in
 * CONSEQA_DEMO_READ_URL holds SELECT on this table and nothing else, so this
 * code could not write even if it tried. That is the stronger of the two.
 */
function sql() {
  const connectionString = process.env.CONSEQA_DEMO_READ_URL;
  if (!connectionString) {
    throw new Error("CONSEQA_DEMO_READ_URL is not configured in the local runner");
  }
  return neon(connectionString);
}

interface CreditRow extends Record<string, unknown> {
  id: string;
  customer_id: string;
  amount_minor: number;
  currency: string;
  status: string;
  correlation_key: string;
}

export const storeCreditIssuedRunner = {
  /**
   * Finds the row the lost INSERT may or may not have written, by the key the
   * SDK issued before the statement was ever sent.
   */
  async discover(context: DiscoveryContext<JsonObject>) {
    try {
      const rows = (await sql().query(
        `select id::text as id from ${TABLE} where correlation_key = $1 limit 2`,
        [context.providerCorrelationKey],
      )) as { id: string }[];
      if (rows.length > 1) {
        return {
          kind: "ambiguous" as const,
          candidateCount: rows.length,
          reason: "More than one row carries this correlation key",
        };
      }
      const row = rows[0];
      if (!row) return { kind: "not_found" as const, retryAfterMs: 1_000 };
      return { kind: "found" as const, binding: { creditId: row.id, recovered: true } };
    } catch (error) {
      return {
        kind: "error" as const,
        reason: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }
  },

  async verify(context: VerificationContext<JsonObject, JsonObject>) {
    const intent = context.intent as { customerId: string; amountMinor: number; currency: string };
    const binding = context.binding as { creditId: string };

    let row: CreditRow | undefined;
    try {
      const rows = (await sql().query(
        `select id::text as id, customer_id, amount_minor, currency, status,
                correlation_key, created_at::text as created_at
           from ${TABLE}
          where id = $1
          limit 2`,
        [binding.creditId],
      )) as CreditRow[];
      if (rows.length > 1) {
        return {
          kind: "inconclusive" as const,
          reason: "More than one row matched",
          retryable: false,
        };
      }
      row = rows[0];
    } catch (error) {
      return {
        kind: "inconclusive" as const,
        reason: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }
    if (!row) {
      return {
        kind: "inconclusive" as const,
        reason: "No matching row exists yet",
        retryable: true,
      };
    }

    const predicates: JsonPredicate[] = [
      { path: "/status", operator: "equals", value: "issued" },
      { path: "/customer_id", operator: "equals", value: intent.customerId },
      { path: "/amount_minor", operator: "equals", value: intent.amountMinor },
      { path: "/currency", operator: "equals", value: intent.currency },
      { path: "/correlation_key", operator: "equals", value: context.providerCorrelationKey },
    ];
    // A credit that was issued and then reversed is a failure, not a pending
    // one: the action happened and its consequence still does not hold.
    const failurePredicates: JsonPredicate[] = [
      { path: "/status", operator: "equals", value: "reversed" },
    ];

    const checks = evaluatePredicates(row, predicates);
    const failureChecks = evaluatePredicates(row, failurePredicates);
    const satisfied = checks.every((check) => check.passed);
    const violated = !satisfied && failureChecks.every((check) => check.passed);

    return {
      kind: "observed" as const,
      observation: row as JsonObject,
      verdict: satisfied
        ? ("satisfied" as const)
        : violated
          ? ("violated" as const)
          : ("pending" as const),
      checks: checks.map((check) => ({
        id: check.path,
        passed: check.passed,
        ...(check.expected === undefined ? {} : { expected: check.expected as never }),
        ...(check.observed === undefined ? {} : { observed: check.observed as never }),
      })),
      evidence: {
        source: "postgresql:conseqa_demo.store_credits",
        observedAt: new Date().toISOString(),
        fields: row as JsonObject,
      } as never,
    };
  },
};
