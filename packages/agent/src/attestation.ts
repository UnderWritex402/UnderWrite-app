import { keccak256 } from "viem";
import { sign } from "viem/accounts";
import type { EvidenceReport } from "./types.js";

/**
 * Attestation payload construction and signing.
 *
 * The contract on the TrusTrove side has to rebuild these exact bytes to
 * recover the signer, so the encoding below is a wire format, not an
 * implementation detail. Every field is fixed-width or explicitly
 * length-prefixed: there is no place where two different sets of inputs can
 * serialise to the same byte string, which is what stops a crafted
 * `agent_id` from impersonating part of an `evidence_hash`.
 *
 * ```text
 * offset  size  field
 * 0       25    domain separator, ASCII "UNDERWRITE_ATTESTATION_V1"
 * 25      32    invoice_id,   raw BytesN<32>, copied verbatim
 * 57      4     risk_score,   u32 big-endian, basis points 0-10000
 * 61      32    evidence_hash, keccak256 of the canonical evidence report
 * 93      1     agent_id length, u8 (1-32)
 * 94      N     agent_id, ASCII, matching the Soroban Symbol charset
 * 94+N    32    nonce
 * ```
 *
 * `invoice_id` is a `BytesN<32>` on the TrusTrove side
 * (`list_for_financing(env, invoice_id: BytesN<32>, discount_bps: u32)`),
 * so it is copied in as raw bytes. It is deliberately never parsed as a
 * number: a numeric round-trip would drop leading zero bytes and normalise
 * distinct ids onto the same integer, so the contract would rebuild a
 * different preimage and signature recovery would fail.
 *
 * The signed digest is `keccak256` of that whole preimage. The preimage
 * itself is what goes on the wire as `payload`, so the contract can check
 * that the invoice id and risk score inside it match the ones it is storing,
 * rather than trusting a bare hash.
 */

export const DOMAIN_SEPARATOR = "UNDERWRITE_ATTESTATION_V1";

const DOMAIN_BYTES = new TextEncoder().encode(DOMAIN_SEPARATOR);
const INVOICE_ID_BYTES = 32;
const U32_BYTES = 4;
const HASH_BYTES = 32;
const NONCE_BYTES = 32;
const MAX_AGENT_ID_BYTES = 32;
const MAX_RISK_SCORE = 10_000;

export class AttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttestationError";
  }
}

export interface AttestationFields {
  /** 0x-prefixed 32 bytes, matching the contract's `BytesN<32>`. */
  invoiceId: `0x${string}`;
  /** Basis points, 0-10000. Integer only. */
  riskScore: number;
  /** 0x-prefixed keccak256 of the canonical evidence report. */
  evidenceHash: string;
  /** Soroban Symbol: 1-32 chars of [a-zA-Z0-9_]. */
  agentId: string;
  /** 0x-prefixed 32-byte nonce. */
  nonce: string;
}

export interface SignedAttestation extends AttestationFields {
  /** The full preimage, as passed to the contract's `payload` argument. */
  payload: `0x${string}`;
  /** keccak256(payload) — the digest that was actually signed. */
  digest: `0x${string}`;
  /**
   * 65 bytes: r (32) || s (32) || recovery id (1, value 0 or 1).
   *
   * The recovery id is normalised to 0/1 rather than the 27/28 Ethereum
   * convention, because that is what Soroban's
   * `recover_key_ecdsa_secp256k1` takes as its `recovery_id` argument.
   */
  signature: `0x${string}`;
  recoveryId: number;
}

function hexToBytes(hex: string, expectedLength: number, field: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]*$/.test(hex)) {
    throw new AttestationError(`${field} must be 0x-prefixed hex, got "${hex}"`);
  }
  const body = hex.slice(2);
  if (body.length !== expectedLength * 2) {
    throw new AttestationError(
      `${field} must be ${expectedLength} bytes, got ${body.length / 2}`,
    );
  }
  const bytes = new Uint8Array(expectedLength);
  for (let i = 0; i < expectedLength; i++) {
    bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let out = "0x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out as `0x${string}`;
}

/** Big-endian encoding of an unsigned integer into exactly `size` bytes. */
function encodeUint(value: bigint, size: number, field: string): Uint8Array {
  if (value < 0n) {
    throw new AttestationError(`${field} must not be negative`);
  }
  const max = (1n << BigInt(size * 8)) - 1n;
  if (value > max) {
    throw new AttestationError(`${field} does not fit in ${size} bytes`);
  }
  const bytes = new Uint8Array(size);
  let remaining = value;
  for (let i = size - 1; i >= 0; i--) {
    bytes[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function encodeAgentId(agentId: string): Uint8Array {
  if (!/^[a-zA-Z0-9_]{1,32}$/.test(agentId)) {
    throw new AttestationError(
      `agentId "${agentId}" is not a valid Soroban Symbol (1-32 chars of [a-zA-Z0-9_])`,
    );
  }
  const bytes = new TextEncoder().encode(agentId);
  if (bytes.length > MAX_AGENT_ID_BYTES) {
    throw new AttestationError("agentId exceeds 32 bytes");
  }
  return bytes;
}

/** Builds the attestation preimage. Pure, and the inverse of the table above. */
export function buildAttestationPayload(fields: AttestationFields): {
  payload: `0x${string}`;
  digest: `0x${string}`;
} {
  const invoiceIdBytes = hexToBytes(
    fields.invoiceId,
    INVOICE_ID_BYTES,
    "invoiceId",
  );

  if (!Number.isInteger(fields.riskScore)) {
    throw new AttestationError(
      `riskScore must be an integer number of basis points, got ${fields.riskScore}`,
    );
  }
  if (fields.riskScore < 0 || fields.riskScore > MAX_RISK_SCORE) {
    throw new AttestationError(
      `riskScore ${fields.riskScore} is outside the 0-${MAX_RISK_SCORE} basis point range`,
    );
  }

  const agentIdBytes = encodeAgentId(fields.agentId);
  const parts = [
    DOMAIN_BYTES,
    invoiceIdBytes,
    encodeUint(BigInt(fields.riskScore), U32_BYTES, "riskScore"),
    hexToBytes(fields.evidenceHash, HASH_BYTES, "evidenceHash"),
    Uint8Array.of(agentIdBytes.length),
    agentIdBytes,
    hexToBytes(fields.nonce, NONCE_BYTES, "nonce"),
  ];

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const preimage = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    preimage.set(part, offset);
    offset += part.length;
  }

  const payload = bytesToHex(preimage);
  return { payload, digest: keccak256(preimage) };
}

/**
 * Derives the nonce deterministically from the agent, the invoice, and the
 * report being attested to.
 *
 * Deterministic rather than random on purpose: re-running verification for
 * the same invoice and the same evidence produces byte-identical output, so a
 * retry after a dropped transaction cannot accidentally create a second,
 * differently-signed attestation for one invoice. Replay across invoices is
 * prevented by the invoice id being part of the preimage, and replay of the
 * same invoice by the contract's own duplicate check (FR-12).
 */
export function deriveNonce(
  agentId: string,
  invoiceId: string,
  evidenceHash: string,
): `0x${string}` {
  const encoder = new TextEncoder();
  return keccak256(
    encoder.encode(`${DOMAIN_SEPARATOR}|${agentId}|${invoiceId}|${evidenceHash}`),
  );
}

/**
 * Canonical JSON serialisation: object keys sorted, no insignificant
 * whitespace, bigints rendered as decimal strings.
 *
 * The evidence hash has to be reproducible by anyone holding the report, so
 * the serialisation cannot depend on JavaScript's property insertion order.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AttestationError(
        "evidence report contains a non-finite number, which cannot be canonicalised",
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      // `undefined` is absent in JSON; dropping it here keeps the hash stable
      // whether a field was omitted or explicitly set to undefined.
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
      .join(",")}}`;
  }
  throw new AttestationError(
    `cannot canonicalise value of type ${typeof value}`,
  );
}

/**
 * keccak256 of the canonical report, with `evidenceHash` blanked so the field
 * that carries the hash is not part of what is hashed.
 */
export function hashEvidenceReport(
  report: Omit<EvidenceReport, "evidenceHash"> & { evidenceHash?: string },
): `0x${string}` {
  const { evidenceHash: _ignored, ...rest } = report;
  return keccak256(new TextEncoder().encode(canonicalize(rest)));
}

/** Signs the attestation digest with the agent's secp256k1 identity key. */
export async function signAttestation(
  fields: AttestationFields,
  privateKey: `0x${string}`,
): Promise<SignedAttestation> {
  const { payload, digest } = buildAttestationPayload(fields);

  const signature = await sign({ hash: digest, privateKey });

  // viem reports parity as `yParity` (0/1) and `v` (27/28). Soroban wants the
  // 0/1 form, so normalise here rather than at the call site.
  const recoveryId =
    signature.yParity ?? (signature.v === undefined ? -1 : Number(signature.v) - 27);
  if (recoveryId !== 0 && recoveryId !== 1) {
    throw new AttestationError(
      `unexpected recovery id ${recoveryId}; expected 0 or 1`,
    );
  }

  const r = hexToBytes(signature.r, 32, "signature.r");
  const s = hexToBytes(signature.s, 32, "signature.s");
  const packed = new Uint8Array(65);
  packed.set(r, 0);
  packed.set(s, 32);
  packed[64] = recoveryId;

  return {
    ...fields,
    payload,
    digest,
    signature: bytesToHex(packed),
    recoveryId,
  };
}
