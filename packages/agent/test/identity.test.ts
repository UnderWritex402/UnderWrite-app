import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  IdentityError,
  buildRegistrationDocument,
  ensureRegistered,
} from "../src/identity.js";
import type { GoatRuntime } from "../src/goat/runtime.js";

const PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const account = privateKeyToAccount(PRIVATE_KEY);

const TESTNET_IDENTITY_REGISTRY =
  "0x556089008Fc0a60cD09390Eca93477ca254A5522";

/**
 * A runtime whose wallet and execution layer are scripted. `runAction` in the
 * real runtime just calls `runtime.runtime.run`, so stubbing that one method
 * exercises the identity logic without a chain.
 */
function stubRuntime(options: {
  /** Address `getAgentWallet(id)` reports, keyed by agent id. */
  owners?: Record<string, string>;
  /** Agent id the `register` eth_call predicts. */
  predictedId?: string;
  registerTxHash?: string;
  onRegister?: () => void;
}): GoatRuntime {
  const {
    owners = {},
    predictedId = "7",
    registerTxHash = "0xdeadbeef",
    onRegister,
  } = options;

  const wallet = {
    getChainId: async () => 48816,
    callContract: async (_address: string, _abi: string[], fn: string) => {
      if (fn === "register") return BigInt(predictedId);
      throw new Error(`unexpected callContract: ${fn}`);
    },
  };

  const run = async (
    action: { name: string },
    _ctx: unknown,
    input: Record<string, string>,
  ): Promise<Record<string, unknown>> => {
    switch (action.name) {
      case "erc8004.get_agent_wallet": {
        const owner = owners[input.agentId ?? ""];
        if (owner === undefined) {
          return { ok: false, error: "agent not registered", traceId: "t", action: action.name, attempts: 1 };
        }
        return {
          ok: true,
          output: { agentId: input.agentId, wallet: owner },
          traceId: "t",
          action: action.name,
          attempts: 1,
        };
      }
      case "erc8004.register_agent":
        onRegister?.();
        return {
          ok: true,
          output: { txHash: registerTxHash },
          traceId: "t",
          action: action.name,
          attempts: 1,
        };
      default:
        throw new Error(`unexpected action ${action.name}`);
    }
  };

  return {
    wallet: wallet as never,
    runtime: { run } as never,
    network: "goat-testnet",
    address: account.address,
  };
}

describe("ensureRegistered", () => {
  it("verifies an existing agent id without writing", async () => {
    const onRegister = vi.fn();
    const runtime = stubRuntime({
      owners: { "7": account.address },
      onRegister,
    });

    const identity = await ensureRegistered(runtime, {
      ERC8004_AGENT_ID: "7",
    });

    expect(identity.agentId).toBe("7");
    expect(identity.newlyRegistered).toBe(false);
    expect(onRegister).not.toHaveBeenCalled();
  });

  it("builds the eip155 registry identifier from the resolved address", async () => {
    const runtime = stubRuntime({ owners: { "7": account.address } });
    const identity = await ensureRegistered(runtime, { ERC8004_AGENT_ID: "7" });

    expect(identity.registryIdentifier).toBe(
      `eip155:48816:${TESTNET_IDENTITY_REGISTRY}`,
    );
  });

  it("refuses an agent id owned by a different address", async () => {
    const runtime = stubRuntime({
      owners: { "7": "0x000000000000000000000000000000000000dEaD" },
    });

    await expect(
      ensureRegistered(runtime, { ERC8004_AGENT_ID: "7" }),
    ).rejects.toThrow(/not owned by/);
  });

  it("registers and confirms the predicted agent id", async () => {
    const owners: Record<string, string> = {};
    const runtime = stubRuntime({
      owners,
      predictedId: "12",
      registerTxHash: "0xabc",
      // The registry assigns the id once the write lands.
      onRegister: () => {
        owners["12"] = account.address;
      },
    });

    const identity = await ensureRegistered(runtime, {
      AGENT_REGISTRATION_URI: "ipfs://registration.json",
    });

    expect(identity.agentId).toBe("12");
    expect(identity.newlyRegistered).toBe(true);
    expect(identity.txHash).toBe("0xabc");
  });

  it("refuses to proceed when the predicted id was taken by someone else", async () => {
    const owners: Record<string, string> = {};
    const runtime = stubRuntime({
      owners,
      predictedId: "12",
      registerTxHash: "0xabc",
      // A competing registration took id 12 first.
      onRegister: () => {
        owners["12"] = "0x000000000000000000000000000000000000dEaD";
      },
    });

    const error = await ensureRegistered(runtime, {
      AGENT_REGISTRATION_URI: "ipfs://registration.json",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IdentityError);
    // The tx hash must survive, or the operator cannot find the real id.
    expect((error as IdentityError).txHash).toBe("0xabc");
    expect((error as IdentityError).message).toMatch(/do not re-run/i);
  });

  it("requires a registration URI before registering", async () => {
    const runtime = stubRuntime({});
    await expect(ensureRegistered(runtime, {})).rejects.toThrow(
      /AGENT_REGISTRATION_URI/,
    );
  });
});

describe("buildRegistrationDocument", () => {
  it("declares x402 support and the reputation trust model", () => {
    const doc = buildRegistrationDocument({
      registryIdentifier: `eip155:48816:${TESTNET_IDENTITY_REGISTRY}`,
      agentId: "7",
      x402Endpoint: "https://underwrite.example/x402",
      imageUrl: "https://underwrite.example/logo.png",
    });

    expect(doc.x402Support).toBe(true);
    expect(doc.supportedTrust).toEqual(["reputation"]);
    expect(doc.registrations).toEqual([
      {
        agentRegistry: `eip155:48816:${TESTNET_IDENTITY_REGISTRY}`,
        agentId: 7,
      },
    ]);
  });

  it("omits agentId entirely rather than guessing one", () => {
    const doc = buildRegistrationDocument({
      registryIdentifier: `eip155:48816:${TESTNET_IDENTITY_REGISTRY}`,
      agentId: null,
      x402Endpoint: "https://underwrite.example/x402",
      imageUrl: "https://underwrite.example/logo.png",
    });

    const registrations = doc.registrations as Array<Record<string, unknown>>;
    expect(registrations[0]).not.toHaveProperty("agentId");
  });
});
