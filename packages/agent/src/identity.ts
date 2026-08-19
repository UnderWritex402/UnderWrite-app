import {
  erc8004GetAgentWalletAction,
  erc8004GetReputationAction,
  erc8004RegisterAgentAction,
  erc8004SetAgentURIAction,
  getIdentityRegistryAddress,
} from "@goatnetwork/agentkit";
import { GoatRuntimeError, runAction } from "./goat/runtime.js";
import type { GoatRuntime } from "./goat/runtime.js";
import type { IdentityConfig } from "./config.js";

/**
 * ERC-8004 identity for the verification agent.
 *
 * The agent registers once and thereafter signs every attestation with the
 * same key that owns that identity, so a reader can go from an on-chain
 * attestation to the agent's public reputation without trusting anything this
 * service says about itself.
 *
 * ## The agentId problem
 *
 * `erc8004.register_agent` returns only `{ txHash }`, but every other action
 * in the plugin — `set_agent_uri`, `get_agent_wallet`, `get_reputation` —
 * takes an `agentId`. The registry assigns that id on-chain
 * (`register(string) returns (uint256)`), and AgentKit does not surface it,
 * nor does it expose an address-to-agentId lookup.
 *
 * Rather than guess at an event signature to decode from the receipt, this
 * module resolves the id the way the contract itself reports it: it `eth_call`s
 * `register` before writing, which returns the id that *would* be assigned,
 * then confirms after the write that `getAgentWallet(id)` really does point at
 * this agent's address. Both calls use ABIs taken verbatim from AgentKit's own
 * action implementations, so nothing here depends on an ABI we invented.
 *
 * If the confirmation fails — most plausibly because another registration
 * landed between the simulation and the write — the id is reported as
 * unresolved with the transaction hash attached, and the operator sets
 * `ERC8004_AGENT_ID` explicitly. It never silently proceeds with an id it
 * could not verify.
 */

/** Taken verbatim from AgentKit's `register-agent` action. */
const REGISTER_ABI = [
  "function register(string agentURI) returns (uint256 agentId)",
];

export class IdentityError extends Error {
  /** Set when registration succeeded but the agentId could not be confirmed. */
  readonly txHash: string | null;

  constructor(message: string, txHash: string | null = null) {
    super(message);
    this.name = "IdentityError";
    this.txHash = txHash;
  }
}

export interface AgentIdentity {
  /** uint256 agent id, as a decimal string. */
  agentId: string;
  /** The EVM address that owns the identity and signs attestations. */
  address: `0x${string}`;
  /** `eip155:{chainId}:{identityRegistry}` form used in registration.json. */
  registryIdentifier: string;
  network: string;
  /** True when this call performed the registration rather than finding it. */
  newlyRegistered: boolean;
  /** Registration transaction hash, when this call registered the agent. */
  txHash: string | null;
}

/** Confirms an agentId belongs to this agent's wallet. */
async function ownsAgentId(
  runtime: GoatRuntime,
  agentId: string,
): Promise<boolean> {
  try {
    const result = await runAction(
      runtime,
      erc8004GetAgentWalletAction(runtime.wallet),
      { agentId },
    );
    const owner = (result as { wallet: string }).wallet;
    return owner.toLowerCase() === runtime.address.toLowerCase();
  } catch {
    // An unregistered id reverts rather than returning the zero address.
    return false;
  }
}

/**
 * Asks the registry what id it would assign, without spending anything.
 *
 * `register` is a state-changing function, but `eth_call` executes it against
 * a pending state and returns its declared return value, which is exactly the
 * id we need. Nothing is committed by this call.
 */
async function predictAgentId(
  runtime: GoatRuntime,
  agentURI: string,
): Promise<string> {
  const registry = getIdentityRegistryAddress(runtime.network);
  const result = await runtime.wallet.callContract(
    registry,
    REGISTER_ABI,
    "register",
    [agentURI],
  );
  return String(result);
}

export function registryIdentifier(runtime: GoatRuntime, chainId: number): string {
  return `eip155:${chainId}:${getIdentityRegistryAddress(runtime.network)}`;
}

/**
 * Ensures the agent has an ERC-8004 identity, registering it if absent.
 *
 * Idempotent: with `ERC8004_AGENT_ID` set, this verifies ownership and makes
 * no write at all, so it is safe to call on every startup.
 */
export async function ensureRegistered(
  runtime: GoatRuntime,
  config: IdentityConfig,
): Promise<AgentIdentity> {
  const chainId = await runtime.wallet.getChainId();
  const identifier = registryIdentifier(runtime, chainId);

  if (config.ERC8004_AGENT_ID !== undefined) {
    const owned = await ownsAgentId(runtime, config.ERC8004_AGENT_ID);
    if (!owned) {
      throw new IdentityError(
        `ERC8004_AGENT_ID ${config.ERC8004_AGENT_ID} is not owned by ${runtime.address} on ${runtime.network}. Refusing to continue: attestations would be signed by a key that does not control the advertised identity.`,
      );
    }
    return {
      agentId: config.ERC8004_AGENT_ID,
      address: runtime.address,
      registryIdentifier: identifier,
      network: runtime.network,
      newlyRegistered: false,
      txHash: null,
    };
  }

  if (config.AGENT_REGISTRATION_URI === undefined) {
    throw new IdentityError(
      "AGENT_REGISTRATION_URI must be set to register the agent. It should point at a durably hosted registration.json (IPFS or stable HTTPS), not a temporary URL.",
    );
  }

  const agentURI = config.AGENT_REGISTRATION_URI;
  const predicted = await predictAgentId(runtime, agentURI);

  const { txHash } = await runAction(
    runtime,
    erc8004RegisterAgentAction(runtime.wallet),
    { agentURI },
    // Keyed to the URI so a retry of the same registration cannot mint a
    // second identity.
    { idempotencyKey: `erc8004-register:${runtime.address}:${agentURI}` },
  );

  if (!(await ownsAgentId(runtime, predicted))) {
    throw new IdentityError(
      `Registration transaction ${txHash} was sent, but agentId ${predicted} does not resolve to ${runtime.address}. Another registration probably landed first. Read the assigned id from the transaction and set ERC8004_AGENT_ID explicitly; do not re-run registration, which would create a second identity.`,
      txHash,
    );
  }

  return {
    agentId: predicted,
    address: runtime.address,
    registryIdentifier: identifier,
    network: runtime.network,
    newlyRegistered: true,
    txHash,
  };
}

/** Points the identity at a new registration.json. */
export async function setRegistrationUri(
  runtime: GoatRuntime,
  agentId: string,
  newURI: string,
): Promise<{ txHash: string }> {
  return runAction(runtime, erc8004SetAgentURIAction(runtime.wallet), {
    agentId,
    newURI,
  });
}

export interface ReputationSummary {
  agentId: string;
  /** Number of feedback entries recorded against the agent. */
  count: string;
  summaryValue: string;
  summaryValueDecimals: number;
}

/**
 * Reads the agent's public reputation from the ERC-8004 Reputation Registry.
 *
 * Underwrite never writes here: feedback is given *about* the agent by
 * TrusTrove and investors, which is what makes it worth anything. This service
 * only reads it back.
 *
 * Note what this count is and is not. It counts feedback entries, not
 * completed reports. The agent's completed-report count is derivable from the
 * `AttestationSubmitted` events its attestations emit on Soroban (NFR-2) — it
 * is deliberately not tracked in a local database here, because a local
 * counter would drift from the chain and there would be no way to tell which
 * was right.
 */
export async function getReputation(
  runtime: GoatRuntime,
  agentId: string,
  filter: { clientAddresses?: string[]; tag1?: string; tag2?: string } = {},
): Promise<ReputationSummary> {
  return runAction(runtime, erc8004GetReputationAction(runtime.wallet), {
    agentId,
    clientAddresses: filter.clientAddresses ?? [],
    tag1: filter.tag1 ?? "",
    tag2: filter.tag2 ?? "",
  });
}

/**
 * Builds the registration.json body.
 *
 * `agentId` is filled in from a real registration rather than guessed; callers
 * that have not registered yet get `null` and must not publish the document
 * until they have.
 */
export function buildRegistrationDocument(options: {
  registryIdentifier: string;
  agentId: string | null;
  x402Endpoint: string;
  imageUrl: string;
}): Record<string, unknown> {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Underwrite Verification Agent",
    description:
      "Agent-native due-diligence for TrusTrove invoice financing",
    image: options.imageUrl,
    services: [
      {
        name: "x402",
        endpoint: options.x402Endpoint,
        version: "1.0.0",
      },
    ],
    x402Support: true,
    active: true,
    registrations: [
      {
        agentRegistry: options.registryIdentifier,
        ...(options.agentId === null
          ? {}
          : { agentId: Number(options.agentId) }),
      },
    ],
    supportedTrust: ["reputation"],
  };
}

export { GoatRuntimeError };
