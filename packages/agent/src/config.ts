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

/** The GOAT networks AgentKit's actions declare support for. */
export const GOAT_NETWORKS = ["goat-mainnet", "goat-testnet"] as const;
export type GoatNetwork = (typeof GOAT_NETWORKS)[number];

/**
 * GOAT AgentKit wiring.
 *
 * `AGENT_EVM_PRIVATE_KEY` is deliberately the only name for the secp256k1
 * key. GOAT's own docs call it `PRIVATE_KEY`; that name is too vague to sit
 * next to `STELLAR_SUBMITTER_SECRET` in one `.env` without inviting exactly
 * the confusion NFR-1 exists to prevent, so it is mapped onto AgentKit at the
 * single point of construction instead of being carried as a second variable.
 *
 * The ERC-8004 registry addresses are not configured here at all: AgentKit
 * resolves them from `network` at call time, so there is one source of truth
 * and no address to drift.
 */
const goatSchema = z.object({
  GOAT_NETWORK: z.enum(GOAT_NETWORKS).default("goat-testnet"),
  /** Optional override; AgentKit's built-in RPC for the network is the default. */
  GOAT_RPC_URL: url.optional(),
});

export type GoatConfig = z.infer<typeof goatSchema>;

export function goatConfig(env?: NodeJS.ProcessEnv): GoatConfig {
  return parse("GOAT network", goatSchema, env);
}

/**
 * ERC-8004 identity.
 *
 * `ERC8004_AGENT_ID` is a uint256 assigned by the Identity Registry and is a
 * different identifier from `AGENT_ID`, which is the Soroban Symbol the
 * attestation is signed under. Two registries, two namespaces; conflating
 * them would produce attestations signed under an id no contract knows.
 *
 * It is optional because it does not exist until the agent has registered.
 */
const identitySchema = z.object({
  ERC8004_AGENT_ID: z
    .string()
    .regex(/^\d+$/, "must be a numeric uint256 agent id")
    .optional(),
  /** URL of the hosted registration.json. Must be durable, not temporary. */
  AGENT_REGISTRATION_URI: z.string().min(1).optional(),
});

export type IdentityConfig = z.infer<typeof identitySchema>;

export function identityConfig(env?: NodeJS.ProcessEnv): IdentityConfig {
  return parse("ERC-8004 identity", identitySchema, env);
}

/**
 * x402 merchant portal. Underwrite is the *merchant*: TrusTrove pays for a
 * report and this service receives that payment, so it needs merchant-side
 * credentials, not a payer wallet.
 */
const merchantSchema = z.object({
  MERCHANT_PORTAL_BASE_URL: url,
  MERCHANT_PORTAL_EMAIL: z.string().email(),
  MERCHANT_PORTAL_PASSWORD: z.string().min(1),
});

export type MerchantConfig = z.infer<typeof merchantSchema>;

export function merchantConfig(env?: NodeJS.ProcessEnv): MerchantConfig {
  return parse("x402 merchant portal", merchantSchema, env);
}

const evidenceStoreSchema = z.object({
  EVIDENCE_STORE_DIR: z.string().min(1).default("./.evidence"),
});

export function evidenceStoreConfig(
  env?: NodeJS.ProcessEnv,
): z.infer<typeof evidenceStoreSchema> {
  return parse("evidence store", evidenceStoreSchema, env);
}
