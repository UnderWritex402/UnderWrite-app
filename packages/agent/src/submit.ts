import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { z } from "zod";
import type { SubmissionConfig } from "./config.js";
import type { SignedAttestation } from "./attestation.js";

/**
 * Submits a signed attestation to TrusTrove's Invoice contract.
 *
 * Submission is permissionless by design (FR-10): the contract decides
 * validity from the signature alone, and this account merely pays the fee.
 * That is why nothing here proves who we are to the contract — adding
 * `require_auth` on the caller would reintroduce exactly the trusted-submitter
 * bottleneck the design avoids (SRD §6). If this account runs dry, anyone can
 * carry the same payload and signature and the attestation still lands.
 *
 * Flow: simulate -> assemble -> sign -> send -> poll, with each phase's
 * failure reported distinctly so an operator can tell a contract rejection
 * from a network problem.
 */

export type SubmissionPhase = "simulate" | "send" | "confirm";

export class SubmissionError extends Error {
  readonly phase: SubmissionPhase;
  readonly detail: string | null;

  constructor(phase: SubmissionPhase, message: string, detail: string | null = null) {
    super(message);
    this.name = "SubmissionError";
    this.phase = phase;
    this.detail = detail;
  }
}

/**
 * Raised when the contract reports an attestation already exists for this
 * invoice. Distinct from a generic failure because it is usually *benign*:
 * the most common cause is a retry after a submission that actually
 * succeeded but whose confirmation we did not observe. The replay guard
 * (FR-12) is doing its job, and the caller can treat it as already-done
 * rather than as an error to escalate.
 */
export class AlreadyAttestedError extends SubmissionError {
  constructor(invoiceId: string, detail: string | null) {
    super(
      "simulate",
      `an attestation already exists for invoice ${invoiceId}; the contract's replay guard rejected this submission`,
      detail,
    );
    this.name = "AlreadyAttestedError";
  }
}

export interface SubmissionResult {
  transactionHash: string;
  /** Ledger the transaction was included in, when the RPC reports one. */
  ledger: number | null;
  /** Wall-clock milliseconds spent waiting for confirmation. */
  confirmationMs: number;
}

/**
 * The subset of `rpc.Server` this module uses. Narrowing it to an interface
 * keeps the submission flow testable without a live network.
 */
export interface SorobanServer {
  getAccount(address: string): Promise<{ accountId(): string; sequenceNumber(): string }>;
  simulateTransaction(
    tx: Transaction,
  ): Promise<rpc.Api.SimulateTransactionResponse>;
  sendTransaction(tx: Transaction): Promise<rpc.Api.SendTransactionResponse>;
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
}

type Transaction = Parameters<rpc.Server["sendTransaction"]>[0];

export type SubmissionReconciliationState =
  | "sent"
  | "confirmed"
  | "failed"
  | "manual_review";

export interface SubmissionReconciliationRecord {
  invoiceId: `0x${string}`;
  payloadDigest: `0x${string}`;
  transactionHash: string | null;
  phase: SubmissionPhase;
  state: SubmissionReconciliationState;
  ledger: number | null;
  updatedAt: string;
  detail: string | null;
}

export interface SubmissionReconciliationStore {
  get(invoiceId: `0x${string}`): Promise<SubmissionReconciliationRecord | null>;
  save(record: SubmissionReconciliationRecord): Promise<void>;
}

export interface SubmitDeps {
  server?: SorobanServer | undefined;
  /** Injected so tests do not actually wait between polls. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Total time to wait for confirmation before giving up. */
  confirmationTimeoutMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  reconciliationStore?: SubmissionReconciliationStore | undefined;
  now?: (() => Date) | undefined;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Phrases a contract panic uses for the duplicate-attestation case. */
const ALREADY_ATTESTED_MARKERS = [
  "already attested",
  "attestationexists",
  "attestation_exists",
  "alreadyexists",
  "already_exists",
];

function looksLikeReplayRejection(detail: string): boolean {
  const normalized = detail.toLowerCase().replace(/[\s-]/g, "");
  return ALREADY_ATTESTED_MARKERS.some((marker) =>
    normalized.includes(marker.replace(/[\s_-]/g, "")),
  );
}

export function buildServer(config: SubmissionConfig): SorobanServer {
  return new rpc.Server(config.STELLAR_RPC_URL, {
    allowHttp: config.STELLAR_RPC_URL.startsWith("http://"),
  }) as unknown as SorobanServer;
}

/**
 * Encodes the contract arguments.
 *
 * All three are ScVal byte strings on the wire. `invoice_id` is a
 * `BytesN<32>` — raw bytes, never a numeric type — and `signature` a
 * `BytesN<65>`; the contract enforces those widths on its side, so both are
 * asserted here rather than discovered in a failed simulation.
 */
function buildArgs(
  invoiceId: `0x${string}`,
  payload: `0x${string}`,
  signature: `0x${string}`,
): xdr.ScVal[] {
  const invoiceIdBytes = Buffer.from(invoiceId.slice(2), "hex");
  const payloadBytes = Buffer.from(payload.slice(2), "hex");
  const signatureBytes = Buffer.from(signature.slice(2), "hex");

  if (invoiceIdBytes.length !== 32) {
    throw new SubmissionError(
      "simulate",
      `invoice_id must be 32 bytes for BytesN<32>, got ${invoiceIdBytes.length}`,
    );
  }

  if (signatureBytes.length !== 65) {
    throw new SubmissionError(
      "simulate",
      `signature must be 65 bytes for BytesN<65>, got ${signatureBytes.length}`,
    );
  }

  return [
    xdr.ScVal.scvBytes(invoiceIdBytes),
    xdr.ScVal.scvBytes(payloadBytes),
    xdr.ScVal.scvBytes(signatureBytes),
  ];
}

export async function submitAttestation(
  signed: SignedAttestation,
  config: SubmissionConfig,
  deps: SubmitDeps = {},
): Promise<SubmissionResult> {
  const server = deps.server ?? buildServer(config);
  const sleep = deps.sleep ?? defaultSleep;
  const confirmationTimeoutMs = deps.confirmationTimeoutMs ?? 60_000;
  const pollIntervalMs = deps.pollIntervalMs ?? 1_000;
  const now = deps.now ?? (() => new Date());
  const store = deps.reconciliationStore;

  const saveReconciliation = async (
    partial: Omit<
      SubmissionReconciliationRecord,
      "invoiceId" | "payloadDigest" | "updatedAt"
    >,
  ): Promise<void> => {
    if (store === undefined) return;
    await store.save({
      invoiceId: signed.invoiceId,
      payloadDigest: signed.digest,
      updatedAt: now().toISOString(),
      ...partial,
    });
  };

  if (store !== undefined) {
    const existing = await store.get(signed.invoiceId);
    if (existing !== null) {
      if (existing.payloadDigest.toLowerCase() !== signed.digest.toLowerCase()) {
        throw new SubmissionError(
          "simulate",
          `reconciliation record for invoice ${signed.invoiceId} has a different payload digest (${existing.payloadDigest} vs ${signed.digest}); manual review required`,
          existing.payloadDigest,
        );
      }

      if (existing.state === "confirmed" && existing.transactionHash !== null) {
        return {
          transactionHash: existing.transactionHash,
          ledger: existing.ledger,
          confirmationMs: 0,
        };
      }

      if (existing.state === "failed") {
        throw new SubmissionError(
          existing.phase,
          `previous submission for invoice ${signed.invoiceId} is in terminal failed state`,
          existing.detail,
        );
      }

      if (existing.transactionHash !== null) {
        return pollConfirmation(
          server,
          sleep,
          existing.transactionHash,
          signed.invoiceId,
          confirmationTimeoutMs,
          pollIntervalMs,
          saveReconciliation,
          true,
        );
      }
    }
  }

  const submitter = Keypair.fromSecret(config.STELLAR_SUBMITTER_SECRET);
  const contract = new Contract(config.TRUSTROVE_INVOICE_CONTRACT);
  const args = buildArgs(signed.invoiceId, signed.payload, signed.signature);

  const source = await server.getAccount(submitter.publicKey());
  const built = new TransactionBuilder(source as never, {
    fee: BASE_FEE,
    networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call("submit_attestation", ...args))
    .setTimeout(180)
    .build();

  const simulation = await server.simulateTransaction(built as Transaction);
  if (rpc.Api.isSimulationError(simulation)) {
    const detail = simulation.error;
    if (looksLikeReplayRejection(detail)) {
      throw new AlreadyAttestedError(signed.invoiceId, detail);
    }
    throw new SubmissionError(
      "simulate",
      `contract rejected the attestation for invoice ${signed.invoiceId} during simulation`,
      detail,
    );
  }

  // Assembling applies the resource footprint and fee the simulation
  // determined; sending an unassembled transaction fails at the network.
  const prepared = rpc.assembleTransaction(built, simulation).build();
  prepared.sign(submitter);
  const preparedHash = prepared.hash().toString("hex");
  await saveReconciliation({
    transactionHash: preparedHash,
    phase: "send",
    state: "sent",
    ledger: null,
    detail: null,
  });

  const sent = await server.sendTransaction(prepared as Transaction);
  if (sent.status === "ERROR" || sent.status === "DUPLICATE") {
    const errDetail =
      sent.errorResult === undefined ? null : JSON.stringify(sent.errorResult);
    await saveReconciliation({
      transactionHash: sent.hash || preparedHash,
      phase: "send",
      state: "failed",
      ledger: null,
      detail: errDetail,
    });
    throw new SubmissionError(
      "send",
      `Stellar RPC rejected the transaction with status ${sent.status}`,
      errDetail,
    );
  }

  const txHash = sent.hash || preparedHash;
  await saveReconciliation({
    transactionHash: txHash,
    phase: "confirm",
    state: "sent",
    ledger: null,
    detail: null,
  });

  return pollConfirmation(
    server,
    sleep,
    txHash,
    signed.invoiceId,
    confirmationTimeoutMs,
    pollIntervalMs,
    saveReconciliation,
    false,
  );
}

async function pollConfirmation(
  server: SorobanServer,
  sleep: (ms: number) => Promise<void>,
  txHash: string,
  invoiceId: `0x${string}`,
  confirmationTimeoutMs: number,
  pollIntervalMs: number,
  saveReconciliation: (
    partial: Omit<
      SubmissionReconciliationRecord,
      "invoiceId" | "payloadDigest" | "updatedAt"
    >,
  ) => Promise<void>,
  checkBeforeSleep: boolean,
): Promise<SubmissionResult> {
  const startedAt = Date.now();
  let elapsed = 0;
  let firstIteration = true;

  while (elapsed < confirmationTimeoutMs || (checkBeforeSleep && firstIteration)) {
    if (!(checkBeforeSleep && firstIteration)) {
      await sleep(pollIntervalMs);
    }
    firstIteration = false;
    elapsed = Date.now() - startedAt;

    const result = await server.getTransaction(txHash);

    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      const ledger = "ledger" in result ? Number(result.ledger) : null;
      await saveReconciliation({
        transactionHash: txHash,
        phase: "confirm",
        state: "confirmed",
        ledger,
        detail: null,
      });
      return {
        transactionHash: txHash,
        ledger,
        confirmationMs: elapsed,
      };
    }

    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      const detail =
        "resultXdr" in result && result.resultXdr !== undefined
          ? result.resultXdr.toXDR("base64")
          : null;
      await saveReconciliation({
        transactionHash: txHash,
        phase: "confirm",
        state: "failed",
        ledger: null,
        detail,
      });
      if (detail !== null && looksLikeReplayRejection(detail)) {
        throw new AlreadyAttestedError(invoiceId, detail);
      }
      throw new SubmissionError(
        "confirm",
        `transaction ${txHash} failed on ledger`,
        detail,
      );
    }
    // NOT_FOUND means the RPC has not seen it settle yet: keep polling.
  }

  await saveReconciliation({
    transactionHash: txHash,
    phase: "confirm",
    state: "manual_review",
    ledger: null,
    detail: `confirmation timed out after ${confirmationTimeoutMs}ms`,
  });

  throw new SubmissionError(
    "confirm",
    `transaction ${txHash} was sent but not confirmed within ${confirmationTimeoutMs}ms. It may still settle; do not resubmit without checking, since the contract's replay guard will reject a second attestation.`,
  );
}

const reconciliationSchema = z.object({
  invoiceId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  payloadDigest: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  transactionHash: z.string().min(1).nullable(),
  phase: z.enum(["simulate", "send", "confirm"]),
  state: z.enum(["sent", "confirmed", "failed", "manual_review"]),
  ledger: z.number().nullable(),
  updatedAt: z.string().min(1),
  detail: z.string().nullable(),
});

export class MemorySubmissionReconciliationStore
  implements SubmissionReconciliationStore
{
  private readonly records = new Map<string, SubmissionReconciliationRecord>();

  constructor(initial: Iterable<SubmissionReconciliationRecord> = []) {
    for (const record of initial) {
      this.records.set(record.invoiceId.toLowerCase(), { ...record });
    }
  }

  async get(
    invoiceId: `0x${string}`,
  ): Promise<SubmissionReconciliationRecord | null> {
    const record = this.records.get(invoiceId.toLowerCase());
    return record === undefined ? null : { ...record };
  }

  async save(record: SubmissionReconciliationRecord): Promise<void> {
    this.records.set(record.invoiceId.toLowerCase(), { ...record });
  }
}

export class FileSubmissionReconciliationStore
  implements SubmissionReconciliationStore
{
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  private recordPath(invoiceId: `0x${string}`): string {
    const normalized = invoiceId.toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
      throw new SubmissionError(
        "simulate",
        `invalid invoice_id "${invoiceId}" for reconciliation storage`,
      );
    }
    return join(this.directory, `${normalized.slice(2)}.json`);
  }

  async get(
    invoiceId: `0x${string}`,
  ): Promise<SubmissionReconciliationRecord | null> {
    try {
      const raw = await readFile(this.recordPath(invoiceId), "utf8");
      const parsed = reconciliationSchema.parse(JSON.parse(raw));
      return {
        ...parsed,
        invoiceId: parsed.invoiceId.toLowerCase() as `0x${string}`,
        payloadDigest: parsed.payloadDigest.toLowerCase() as `0x${string}`,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw new SubmissionError(
        "simulate",
        `corrupt submission reconciliation record for invoice ${invoiceId}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async save(record: SubmissionReconciliationRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = this.recordPath(record.invoiceId);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(temp, target);
  }
}
