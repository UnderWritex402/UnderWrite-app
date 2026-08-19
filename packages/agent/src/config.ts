import { z } from "zod";

/**
 * Environment configuration.
 *
 * Config is resolved lazily and per-concern rather than as one eager block,
 * so that running (say) document forensics in a test does not require a
 * Stellar submitter secret to be present. Each getter validates only the
 * variables its own subsystem needs, and throws a named error naming the
 * missing variable rather than failing later with an undefined.
 *
 * No secret is ever logged, defaulted, or committed (SRD §6).
 */

export class ConfigError extends Error {
  constructor(subsystem: string, issues: string) {
    super(`Invalid configuration for ${subsystem}: ${issues}`);
    this.name = "ConfigError";
  }
}

function parse<T extends z.ZodTypeAny>(
  subsystem: string,
  schema: T,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new ConfigError(subsystem, issues);
  }
  return parsed.data;
}

const hexKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex string");

const url = z.string().url();

/**
 * The secp256k1 key that signs attestation *content*, and the agent's
 * ERC-8004 identity key. Distinct from the Stellar submitter key (NFR-1).
 */
const agentIdentitySchema = z.object({
  AGENT_EVM_PRIVATE_KEY: hexKey,
  AGENT_ID: z
    .string()
    .min(1)
    .max(32, "agent_id must fit in a Soroban Symbol (32 chars)")
    .regex(/^[a-zA-Z0-9_]+$/, "Soroban Symbols allow only [a-zA-Z0-9_]"),
});

export type AgentIdentityConfig = z.infer<typeof agentIdentitySchema>;

export function agentIdentityConfig(
  env?: NodeJS.ProcessEnv,
): AgentIdentityConfig {
  return parse("agent identity", agentIdentitySchema, env);
}

/**
 * The Stellar keypair that pays the Soroban transaction fee. It carries the
 * attestation but has no authority over its contents — submission is
 * permissionless by design (SRD FR-10).
 */
const submissionSchema = z.object({
  STELLAR_RPC_URL: url,
  STELLAR_NETWORK_PASSPHRASE: z.string().min(1),
  STELLAR_SUBMITTER_SECRET: z
    .string()
    .regex(/^S[A-Z2-7]{55}$/, "must be a Stellar secret seed (S...)"),
  TRUSTROVE_INVOICE_CONTRACT: z
    .string()
    .regex(/^C[A-Z2-7]{55}$/, "must be a Soroban contract id (C...)"),
});

export type SubmissionConfig = z.infer<typeof submissionSchema>;

export function submissionConfig(env?: NodeJS.ProcessEnv): SubmissionConfig {
  return parse("Soroban submission", submissionSchema, env);
}

const platformHistorySchema = z.object({
  TRUSTROVE_INDEXER_URL: url,
  TRUSTROVE_INDEXER_API_KEY: z.string().min(1).optional(),
});

export type PlatformHistoryConfig = z.infer<typeof platformHistorySchema>;

export function platformHistoryConfig(
  env?: NodeJS.ProcessEnv,
): PlatformHistoryConfig {
  return parse("TrusTrove indexer", platformHistorySchema, env);
}

const cacLookupSchema = z.object({
  CAC_LOOKUP_PROVIDER: z.enum(["dojah", "mono", "zeeh"]),
  CAC_LOOKUP_BASE_URL: url,
  CAC_LOOKUP_API_KEY: z.string().min(1),
  /** Dojah requires an app id alongside the secret key; others ignore it. */
  CAC_LOOKUP_APP_ID: z.string().min(1).optional(),
});

export type CacLookupConfig = z.infer<typeof cacLookupSchema>;

export function cacLookupConfig(env?: NodeJS.ProcessEnv): CacLookupConfig {
  return parse("CAC lookup", cacLookupSchema, env);
}

const evidenceStoreSchema = z.object({
  EVIDENCE_STORE_DIR: z.string().min(1).default("./.evidence"),
});

export function evidenceStoreConfig(
  env?: NodeJS.ProcessEnv,
): z.infer<typeof evidenceStoreSchema> {
  return parse("evidence store", evidenceStoreSchema, env);
}
