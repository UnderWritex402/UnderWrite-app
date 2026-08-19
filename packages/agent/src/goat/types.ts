/**
 * Re-exports of the AgentKit types this service uses.
 *
 * AgentKit exposes these from deep paths under `dist/core/...` that are not
 * listed in its package `exports` map, so importing them directly is not
 * possible. Re-deriving them here keeps every other module importing from one
 * stable local path, and gives one place to fix if AgentKit's shapes move.
 */

import type { ZodTypeAny } from "zod";

/** The context every action receives. Mirrors AgentKit's `ActionContext`. */
export interface ActionContext {
  traceId: string;
  network: string;
  caller?: string;
  now: number;
  signal?: AbortSignal;
  /** Bearer token for merchant portal actions. Excluded from logs by AgentKit. */
  accessToken?: string;
  idempotencyKey?: string;
}

export type RiskLevel = "read" | "low" | "medium" | "high";

/**
 * Structural type for an AgentKit action, mirroring its `ActionDefinition`.
 *
 * Only the fields this service reads or passes through are declared. Because
 * it is structural, an action object from AgentKit satisfies it without any
 * cast, and a shape change on their side surfaces as a type error here rather
 * than as a runtime surprise.
 */
export interface ActionDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  requiresConfirmation: boolean;
  networks: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  zodInputSchema?: ZodTypeAny;
  zodOutputSchema?: ZodTypeAny;
  sensitiveOutputFields?: string[];
  sensitiveInputFields?: string[];
  execute: (ctx: ActionContext, input: TInput) => Promise<TOutput>;
}
