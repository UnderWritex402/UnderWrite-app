import {
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
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

export interface SubmitDeps {
  server?: SorobanServer;
  /** Injected so tests do not actually wait between polls. */
  sleep?: (ms: number) => Promise<void>;
  /** Total time to wait for confirmation before giving up. */
  confirmationTimeoutMs?: number;
  pollIntervalMs?: number;
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
 * `payload` and `signature` are both ScVal byte strings on the wire; the
 * contract's `Bytes` versus `BytesN<65>` distinction is enforced on its side,
 * so the 65-byte length is asserted here rather than discovered in a failed
 * simulation.
 */
function buildArgs(
  invoiceId: string,
  payload: `0x${string}`,
  signature: `0x${string}`,
): xdr.ScVal[] {
  const payloadBytes = Buffer.from(payload.slice(2), "hex");
  const signatureBytes = Buffer.from(signature.slice(2), "hex");

  if (signatureBytes.length !== 65) {
    throw new SubmissionError(
      "simulate",
      `signature must be 65 bytes for BytesN<65>, got ${signatureBytes.length}`,
    );
  }

  return [
    nativeToScVal(BigInt(invoiceId), { type: "u128" }),
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

  const sent = await server.sendTransaction(prepared as Transaction);
  if (sent.status === "ERROR" || sent.status === "DUPLICATE") {
    throw new SubmissionError(
      "send",
      `Stellar RPC rejected the transaction with status ${sent.status}`,
      sent.errorResult === undefined ? null : JSON.stringify(sent.errorResult),
    );
  }

  const startedAt = Date.now();
  let elapsed = 0;

  while (elapsed < confirmationTimeoutMs) {
    await sleep(pollIntervalMs);
    elapsed = Date.now() - startedAt;

    const result = await server.getTransaction(sent.hash);

    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return {
        transactionHash: sent.hash,
        ledger: "ledger" in result ? Number(result.ledger) : null,
        confirmationMs: elapsed,
      };
    }

    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      const detail =
        "resultXdr" in result && result.resultXdr !== undefined
          ? result.resultXdr.toXDR("base64")
          : null;
      if (detail !== null && looksLikeReplayRejection(detail)) {
        throw new AlreadyAttestedError(signed.invoiceId, detail);
      }
      throw new SubmissionError(
        "confirm",
        `transaction ${sent.hash} failed on ledger`,
        detail,
      );
    }
    // NOT_FOUND means the RPC has not seen it settle yet: keep polling.
  }

  throw new SubmissionError(
    "confirm",
    `transaction ${sent.hash} was sent but not confirmed within ${confirmationTimeoutMs}ms. It may still settle; do not resubmit without checking, since the contract's replay guard will reject a second attestation.`,
  );
}
