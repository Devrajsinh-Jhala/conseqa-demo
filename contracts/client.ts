import { randomBytes } from "node:crypto";

/**
 * The application half. It runs inside the agent's process and never reads the
 * database: everything here happens around the INSERT the agent was already
 * going to make.
 */
export const storeCreditIssuedClient = {
  name: "store.credit.issued",
  version: 1,
  operation: "store_credit.insert",
  capabilities: { lostResponseDiscovery: true },
  intentSchema: {
    parse: (value: unknown) => value,
  },
  bindingSchema: {
    parse: (value: unknown) => value,
  },
  observationSchema: {
    parse: (value: unknown) => value,
  },
  client: {
    // Written into the row itself, which is what makes a lost INSERT findable
    // afterwards without guessing from timestamps.
    deriveProviderCorrelationKey: () => `cq_${randomBytes(12).toString("hex")}`,
    bindResult: (result: unknown) => {
      if (result === null || typeof result !== "object") return null;
      const id = (result as { id?: unknown }).id;
      return typeof id === "string" ? { creditId: id, recovered: false } : null;
    },
    classifyException(error: unknown) {
      // A dropped connection proves nothing about whether the row committed.
      // Postgres executes and commits an autocommit INSERT before it replies,
      // so the write may well have landed. Anything other than "ambiguous"
      // here would be a guess.
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : undefined;
      // 23505 is a unique violation on the correlation key: this exact
      // statement already succeeded, which is a definite answer.
      if (code === "23505") {
        return { certainty: "ambiguous" as const, retryable: false, code: "duplicate_key" };
      }
      return {
        certainty: "ambiguous" as const,
        retryable: true,
        code: code ?? (error instanceof Error ? error.name : "unknown_error"),
      };
    },
  },
  // Present because the contract shape requires it, and deliberately unusable:
  // reading the database is the runner's job, with the runner's read-only role.
  runner: {
    discover: async (): Promise<never> => {
      throw new Error("Discovery is runner-only");
    },
    verify: async (): Promise<never> => {
      throw new Error("Verification is runner-only");
    },
  },
};
