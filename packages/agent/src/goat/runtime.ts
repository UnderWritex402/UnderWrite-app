import {
  ExecutionRuntime,
  PolicyEngine,
  ViemWalletProvider,
  consoleLogger,
  createIdempotencyStoreFromEnv,
} from "@goatnetwork/agentkit";
import { goatNetworks } from "@goatnetwork/agentkit/networks";
import { http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ActionContext, ActionDefinition } from "./types.js";
import type { AgentIdentityConfig, GoatConfig } from "../config.js";

/**
 * The single place AgentKit is constructed.
 *
 * Everything GOAT-specific is concentrated here so the verification pipeline
 * itself stays free of AgentKit types: the sources, scoring, and attestation
 * modules know nothing about it, which is what let them be built and tested
 * before this file existed.
 *
 * Two things are deliberately *not* configurable:
 *
 * - **ERC-8004 registry addresses.** AgentKit resolves them from the network
 *   name at call time. Pinning them in our own config would create a second
 *   source of truth that silently rots when GOAT redeploys.
 * - **The signing key's name.** GOAT's docs call it `PRIVATE_KEY`; this
 *   service calls it `AGENT_EVM_PRIVATE_KEY` everywhere and maps it here.
 *   The mapping happens once, in one function, so there is never a moment
 *   where it could be confused with `STELLAR_SUBMITTER_SECRET` (NFR-1).
 */

export interface GoatRuntime {
  /** Signs ERC-8004 writes and identifies the agent on GOAT. */
  wallet: ViemWalletProvider;
  /** Enforces the risk policy and retries/idempotency around actions. */
  runtime: ExecutionRuntime;
  /** The network every action runs against. */
  network: string;
  /** The agent's EVM address, which is its ERC-8004 identity. */
  address: `0x${string}`;
}

export class GoatRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoatRuntimeError";
  }
}

/** Builds a viem chain from AgentKit's own network table. */
function chainFor(config: GoatConfig): ReturnType<typeof defineChain> {
  const network = goatNetworks[config.GOAT_NETWORK];
  if (network === undefined) {
    throw new GoatRuntimeError(
      `AgentKit does not know the network "${config.GOAT_NETWORK}"`,
    );
  }

  const rpcUrl = config.GOAT_RPC_URL ?? network.rpcUrl;

  return defineChain({
    id: network.chainId,
    name: network.key,
    nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export interface CreateRuntimeOptions {
  /**
   * Highest risk level that runs without an explicit human confirmation.
   *
   * Underwrite runs headless: verification is triggered by a payment
   * webhook, not by an operator at a terminal. `erc8004.register_agent` is
   * declared `high` and `requiresConfirmation`, so leaving this at the
   * default would deadlock startup registration waiting for a confirmation
   * that nothing can give. Raising it is therefore required, not a
   * loosening of a safety net that was ever going to catch anything here.
   *
   * What actually bounds risk in this service is the narrow set of actions
   * it ever invokes: ERC-8004 identity writes and read-only merchant
   * queries. It never holds user funds and never invokes a transfer action.
   */
  maxRiskWithoutConfirm?: "read" | "low" | "medium" | "high";
  /** Set false to make every write a no-op, for dry runs. */
  writeEnabled?: boolean;
}

export function createGoatRuntime(
  goat: GoatConfig,
  identity: AgentIdentityConfig,
  options: CreateRuntimeOptions = {},
): GoatRuntime {
  const { maxRiskWithoutConfirm = "high", writeEnabled = true } = options;

  const account = privateKeyToAccount(
    identity.AGENT_EVM_PRIVATE_KEY as `0x${string}`,
  );
  const chain = chainFor(goat);

  const wallet = new ViemWalletProvider(
    account,
    chain,
    http(chain.rpcUrls.default.http[0]),
    goat.GOAT_NETWORK,
  );

  const policy = new PolicyEngine({
    allowedNetworks: [goat.GOAT_NETWORK],
    maxRiskWithoutConfirm,
    writeEnabled,
  });

  // Idempotency matters here: a retried ERC-8004 registration must not create
  // a second identity for the same agent. The factory reads
  // AGENTKIT_IDEMPOTENCY_MODE and returns the store alongside the mode it chose.
  const idempotency = createIdempotencyStoreFromEnv();

  const runtime = new ExecutionRuntime(policy, {
    maxRetries: 2,
    retryDelayMs: 500,
    defaultTimeoutMs: 30_000,
    logger: consoleLogger,
    idempotencyStore: idempotency.store,
  });

  return { wallet, runtime, network: goat.GOAT_NETWORK, address: account.address };
}

/** Context passed to every action invocation. */
export function actionContext(
  runtime: GoatRuntime,
  overrides: Partial<ActionContext> = {},
): ActionContext {
  return {
    traceId: `underwrite-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    network: runtime.network,
    now: Date.now(),
    ...overrides,
  };
}

/**
 * Runs an AgentKit action and returns its output, converting the runtime's
 * `{ ok: false }` result into a thrown error.
 *
 * AgentKit reports failure as a value rather than an exception, which is easy
 * to read past. Every call site in this service goes through here so a failed
 * action cannot be mistaken for a successful one with an undefined output.
 */
export async function runAction<TInput, TOutput>(
  runtime: GoatRuntime,
  action: ActionDefinition<TInput, TOutput>,
  input: TInput,
  options: { idempotencyKey?: string; confirmed?: boolean } = {},
): Promise<TOutput> {
  const result = await runtime.runtime.run(
    action,
    actionContext(runtime),
    input,
    {
      confirmed: options.confirmed ?? true,
      ...(options.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: options.idempotencyKey }),
    },
  );

  if (!result.ok || result.output === undefined) {
    throw new GoatRuntimeError(
      `action ${action.name} failed${result.errorCode === undefined ? "" : ` [${result.errorCode}]`}: ${result.error ?? "no output returned"}`,
    );
  }

  return result.output;
}
