import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  FileSubmissionReconciliationStore,
  MemorySubmissionReconciliationStore,
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
  nonce: 42n,
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
}): {
  server: SorobanServer;
  calls: { sent: number; simulated: number; getAccount: number; getTx: number };
} {
  const calls = { sent: 0, simulated: 0, getAccount: 0, getTx: 0 };
  const transactions = [...(overrides.transaction ?? [])];

  const server: SorobanServer = {
    getAccount: async () => {
      calls.getAccount += 1;
      return new Account(submitter.publicKey(), "1") as never;
    },
    simulateTransaction: async () => {
      calls.simulated += 1;
      return (overrides.simulate ?? rawSuccessfulSimulation()) as never;
    },
    sendTransaction: async () => {
      calls.sent += 1;
      return (overrides.send ?? { status: "PENDING", hash: "abc123" }) as never;
    },
    getTransaction: async () => {
      calls.getTx += 1;
      return (transactions.shift() ?? {
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
      }) as never;
    },
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

describe("durable transaction reconciliation (Issue #22)", () => {
  it("resumes confirmation after a crash following send without building or sending a new transaction", async () => {
    const dir = await mkdtemp(join(tmpdir(), "underwrite-reconcile-"));
    try {
      const store1 = new FileSubmissionReconciliationStore(dir);
      await store1.save({
        invoiceId: signed.invoiceId,
        payloadDigest: signed.digest,
        transactionHash: "saved_tx_hash_999",
        phase: "confirm",
        state: "sent",
        ledger: null,
        updatedAt: "2026-03-01T00:00:00.000Z",
        detail: null,
      });

      // Simulate restart: new store instance reads persisted state while tx settled offline
      const store2 = new FileSubmissionReconciliationStore(dir);
      const { server, calls } = stubServer({
        transaction: [
          { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 4040 },
        ],
      });

      const result = await submitAttestation(signed, config, {
        server,
        sleep: noSleep,
        pollIntervalMs: 0,
        reconciliationStore: store2,
      });

      expect(result.transactionHash).toBe("saved_tx_hash_999");
      expect(result.ledger).toBe(4040);
      expect(calls.getAccount).toBe(0);
      expect(calls.simulated).toBe(0);
      expect(calls.sent).toBe(0);

      const persisted = await store2.get(signed.invoiceId);
      expect(persisted?.state).toBe("confirmed");
      expect(persisted?.ledger).toBe(4040);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns immediately without network traffic when reconciliation shows already confirmed", async () => {
    const store = new MemorySubmissionReconciliationStore([
      {
        invoiceId: signed.invoiceId,
        payloadDigest: signed.digest,
        transactionHash: "confirmed_tx_1",
        phase: "confirm",
        state: "confirmed",
        ledger: 512,
        updatedAt: "2026-03-01T00:00:00.000Z",
        detail: null,
      },
    ]);
    const { server, calls } = stubServer({});

    const result = await submitAttestation(signed, config, {
      server,
      sleep: noSleep,
      reconciliationStore: store,
    });

    expect(result).toEqual({
      transactionHash: "confirmed_tx_1",
      ledger: 512,
      confirmationMs: 0,
    });
    expect(calls.getAccount).toBe(0);
    expect(calls.simulated).toBe(0);
    expect(calls.sent).toBe(0);
    expect(calls.getTx).toBe(0);
  });

  it("records terminal failed state on ledger failure and refuses blind retry on restart", async () => {
    const store = new MemorySubmissionReconciliationStore();
    const { server, calls } = stubServer({
      transaction: [{ status: rpc.Api.GetTransactionStatus.FAILED }],
    });

    await expect(
      submitAttestation(signed, config, {
        server,
        sleep: noSleep,
        pollIntervalMs: 0,
        reconciliationStore: store,
      }),
    ).rejects.toMatchObject({ phase: "confirm" });

    const saved = await store.get(signed.invoiceId);
    expect(saved?.state).toBe("failed");
    expect(saved?.transactionHash).toBe("abc123");

    // Restart attempt must fail before building a new transaction
    await expect(
      submitAttestation(signed, config, {
        server,
        sleep: noSleep,
        pollIntervalMs: 0,
        reconciliationStore: store,
      }),
    ).rejects.toThrow(/terminal failed state/);
    expect(calls.sent).toBe(1);
  });

  it("marks unresolved timeout as manual_review and allows recovery polling on restart", async () => {
    const store = new MemorySubmissionReconciliationStore();
    const { server: timeoutServer } = stubServer({});

    await expect(
      submitAttestation(signed, config, {
        server: timeoutServer,
        sleep: noSleep,
        pollIntervalMs: 0,
        confirmationTimeoutMs: 1,
        reconciliationStore: store,
      }),
    ).rejects.toThrow(/do not resubmit/);

    const timedOut = await store.get(signed.invoiceId);
    expect(timedOut?.state).toBe("manual_review");
    expect(timedOut?.transactionHash).toBe("abc123");

    // On restart, checks the saved hash first and observes late settlement
    const { server: recoveryServer, calls: recoveryCalls } = stubServer({
      transaction: [
        { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 7777 },
      ],
    });

    const recovered = await submitAttestation(signed, config, {
      server: recoveryServer,
      sleep: noSleep,
      pollIntervalMs: 0,
      reconciliationStore: store,
    });
    expect(recovered.transactionHash).toBe("abc123");
    expect(recovered.ledger).toBe(7777);
    expect(recoveryCalls.sent).toBe(0);
  });
});
