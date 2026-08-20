import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  Account,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import {
  AlreadyAttestedError,
  SubmissionError,
  submitAttestation,
} from "../src/submit.js";
import type { SorobanServer } from "../src/submit.js";
import type { SubmissionConfig } from "../src/config.js";
import type { SignedAttestation } from "../src/attestation.js";

const submitter = Keypair.random();

const config: SubmissionConfig = {
  STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  STELLAR_NETWORK_PASSPHRASE: Networks.TESTNET,
  STELLAR_SUBMITTER_SECRET: submitter.secret(),
  TRUSTROVE_INVOICE_CONTRACT: StrKey.encodeContract(randomBytes(32)),
};

const signed: SignedAttestation = {
  invoiceId: `0x${"7f".repeat(32)}`,
  riskScore: 1_250,
  evidenceHash: `0x${"ab".repeat(32)}`,
  agentId: "underwrite_v1",
  nonce: `0x${"cd".repeat(32)}`,
  payload: `0x${"11".repeat(120)}`,
  digest: `0x${"22".repeat(32)}`,
  signature: `0x${"33".repeat(65)}`,
  recoveryId: 0,
};

/**
 * A successful simulation in the shape the RPC actually puts on the wire:
 * base64 XDR strings, not already-parsed SDK objects. `assembleTransaction`
 * runs the real parser over this, so the footprint and resource fee it reads
 * have to be genuine XDR rather than a convenient stand-in.
 */
function rawSuccessfulSimulation(): Record<string, unknown> {
  return {
    transactionData: new SorobanDataBuilder().build().toXDR("base64"),
    minResourceFee: "100",
    results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXDR("base64") }],
    events: [],
    latestLedger: 1,
  };
}

/**
 * A stub standing in for the real contract. `simulate` and `getTransaction`
 * are scripted per test; everything else behaves like a healthy network.
 */
function stubServer(overrides: {
  simulate?: unknown;
  send?: unknown;
  transaction?: unknown[];
}): { server: SorobanServer; calls: { sent: number } } {
  const calls = { sent: 0 };
  const transactions = [...(overrides.transaction ?? [])];

  const server: SorobanServer = {
    getAccount: async () => new Account(submitter.publicKey(), "1") as never,
    simulateTransaction: async () =>
      (overrides.simulate ?? rawSuccessfulSimulation()) as never,
    sendTransaction: async () => {
      calls.sent += 1;
      return (overrides.send ?? { status: "PENDING", hash: "abc123" }) as never;
    },
    getTransaction: async () =>
      (transactions.shift() ?? {
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
      }) as never,
  };

  return { server, calls };
}

const noSleep = async (): Promise<void> => {};

describe("submitAttestation", () => {
  it("surfaces a contract rejection at simulation without sending", async () => {
    const { server, calls } = stubServer({
      simulate: { error: "HostError: Error(Contract, #7) invalid signature" },
    });

    await expect(
      submitAttestation(signed, config, { server, sleep: noSleep }),
    ).rejects.toThrow(SubmissionError);
    expect(calls.sent).toBe(0);
  });

  it("recognises the replay guard as an AlreadyAttestedError", async () => {
    const { server } = stubServer({
      simulate: { error: "HostError: Error(Contract, #3) AttestationExists" },
    });

    await expect(
      submitAttestation(signed, config, { server, sleep: noSleep }),
    ).rejects.toBeInstanceOf(AlreadyAttestedError);
  });

  it("rejects a signature that is not 65 bytes before touching the network", async () => {
    const { server, calls } = stubServer({});
    await expect(
      submitAttestation(
        { ...signed, signature: `0x${"33".repeat(64)}` },
        config,
        { server, sleep: noSleep },
      ),
    ).rejects.toThrow(/65 bytes/);
    expect(calls.sent).toBe(0);
  });

  it("reports a send-phase rejection distinctly", async () => {
    const { server } = stubServer({
      send: { status: "ERROR", hash: "abc123", errorResult: { code: "tx_bad_seq" } },
    });

    await expect(
      submitAttestation(signed, config, { server, sleep: noSleep }),
    ).rejects.toMatchObject({ phase: "send" });
  });

  it("polls past NOT_FOUND until the transaction succeeds", async () => {
    const { server } = stubServer({
      transaction: [
        { status: rpc.Api.GetTransactionStatus.NOT_FOUND },
        { status: rpc.Api.GetTransactionStatus.NOT_FOUND },
        { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 987 },
      ],
    });

    const result = await submitAttestation(signed, config, {
      server,
      sleep: noSleep,
      pollIntervalMs: 0,
    });

    expect(result.transactionHash).toBe("abc123");
    expect(result.ledger).toBe(987);
  });

  it("reports an on-ledger failure as a confirm-phase error", async () => {
    const { server } = stubServer({
      transaction: [{ status: rpc.Api.GetTransactionStatus.FAILED }],
    });

    await expect(
      submitAttestation(signed, config, {
        server,
        sleep: noSleep,
        pollIntervalMs: 0,
      }),
    ).rejects.toMatchObject({ phase: "confirm" });
  });

  it("times out with a warning against blind resubmission", async () => {
    const { server } = stubServer({});

    await expect(
      submitAttestation(signed, config, {
        server,
        sleep: noSleep,
        pollIntervalMs: 0,
        confirmationTimeoutMs: 1,
      }),
    ).rejects.toThrow(/do not resubmit/);
  });
});
