import { neon } from "@neondatabase/serverless";
import { evaluatePredicates } from "@conseqa/verifiers";
import type { JsonPredicate } from "@conseqa/verifiers";
import type {
  DiscoveryContext,
  JsonObject,
  VerificationContext,
} from "@conseqa/contracts";

const TABLE = "conseqa_demo.store_credits";

/**
 * Reads over Neon's SQL-over-HTTP endpoint rather than through `pg`.
 *
 * The contract bundle is ESM and is loaded by a worker thread from a directory
 * with no node_modules, so a CommonJS driver cannot be used here: `pg` fails to
 * bundle with "Dynamic require of events is not supported", and marking it
 * external only moves the failure to resolution time.
 *
 * These queries use SELECT only. Database-enforced read-only access additionally
 * requires configuring CONSEQA_DEMO_READ_URL with a SELECT-only role. The demo
 * accepts the writer role as a convenience and does not inspect its grants.
 */
function sql() {
  const connectionString = process.env.CONSEQA_DEMO_READ_URL;
  if (!connectionString) {
    throw new Error(
      "CONSEQA_DEMO_READ_URL is not configured in the local runner",
    );
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

type Query = (
  statement: string,
  values: unknown[],
) => Promise<Record<string, unknown>[]>;

function databaseFailure(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  if (["28P01", "28000", "42501"].includes(code)) {
    return {
      reason: "Database authentication or permission failure",
      retryable: false,
    };
  }
  if (["42P01", "42703", "3F000", "3D000"].includes(code)) {
    return {
      reason: "Database schema or configuration mismatch",
      retryable: false,
    };
  }
  // Provider messages can contain connection details; never return them as evidence.
  return { reason: "Database read unavailable", retryable: true };
}

function validRow(row: Record<string, unknown>): row is CreditRow {
  return (
    typeof row.id === "string" &&
    row.id.length > 0 &&
    typeof row.customer_id === "string" &&
    typeof row.amount_minor === "number" &&
    Number.isSafeInteger(row.amount_minor) &&
    typeof row.currency === "string" &&
    typeof row.correlation_key === "string" &&
    typeof row.status === "string" &&
    ["issued", "pending", "reversed"].includes(row.status)
  );
}

/** The injected read boundary lets offline tests execute the real callbacks. */
export function createStoreCreditIssuedRunner(query: Query) {
  return {
    /**
     * Finds the row the lost INSERT may or may not have written, by the key the
     * SDK issued before the statement was ever sent.
     */
    async discover(context: DiscoveryContext<JsonObject>) {
      try {
        const rows = await query(
          `select id::text as id from ${TABLE} where correlation_key = $1 limit 2`,
          [context.providerCorrelationKey],
        );
        if (rows.length > 1) {
          return {
            kind: "ambiguous" as const,
            candidateCount: rows.length,
            reason: "More than one row carries this correlation key",
          };
        }
        const row = rows[0];
        if (!row) return { kind: "not_found" as const, retryAfterMs: 1_000 };
        if (typeof row.id !== "string" || !row.id) {
          return {
            kind: "error" as const,
            reason: "Discovery schema mismatch",
            retryable: false,
          };
        }
        return {
          kind: "found" as const,
          binding: { creditId: row.id, recovered: true },
        };
      } catch (error) {
        return {
          kind: "error" as const,
          ...databaseFailure(error),
        };
      }
    },

    async verify(context: VerificationContext<JsonObject, JsonObject>) {
      const intent = context.intent as {
        customerId: string;
        amountMinor: number;
        currency: string;
      };
      const binding = context.binding as { creditId: string };

      let row: CreditRow | undefined;
      try {
        const rows = await query(
          `select id::text as id, customer_id, amount_minor, currency, status,
                correlation_key, created_at::text as created_at
           from ${TABLE}
          where id = $1
          limit 2`,
          [binding.creditId],
        );
        if (rows.length > 1) {
          return {
            kind: "inconclusive" as const,
            reason: "More than one row matched",
            retryable: false,
          };
        }
        const candidate = rows[0];
        if (candidate && !validRow(candidate)) {
          return {
            kind: "inconclusive" as const,
            reason: "Observation schema mismatch",
            retryable: false,
          };
        }
        row = candidate as CreditRow | undefined;
      } catch (error) {
        return {
          kind: "inconclusive" as const,
          ...databaseFailure(error),
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
        {
          path: "/amount_minor",
          operator: "equals",
          value: intent.amountMinor,
        },
        { path: "/currency", operator: "equals", value: intent.currency },
        {
          path: "/correlation_key",
          operator: "equals",
          value: context.providerCorrelationKey,
        },
      ];
      const checks = evaluatePredicates(row, predicates);
      const satisfied = checks.every((check) => check.passed);
      // Issued is terminal: a wrong amount/customer/correlation is a real mismatch,
      // not a pending result. Only a known pending state remains pending.
      const violated = !satisfied && row.status !== "pending";

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
          ...(check.expected === undefined
            ? {}
            : { expected: check.expected as never }),
          ...(check.observed === undefined
            ? {}
            : { observed: check.observed as never }),
        })),
        evidence: {
          source: "postgresql:conseqa_demo.store_credits",
          observedAt: new Date().toISOString(),
          fields: row as JsonObject,
        } as never,
      };
    },
  };
}

export const storeCreditIssuedRunner = createStoreCreditIssuedRunner(
  async (statement, values) =>
    (await sql().query(statement, values)) as Record<string, unknown>[],
);
