import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { keccak256 } from "viem";
import { sign } from "viem/accounts";
import type { EvidenceReport } from "./types.js";

/**
 * Attestation payload construction and signing.
 *
 * The `payload` argument of TrusTrove's `submit_attestation` is the XDR
 * serialisation of its `AttestationPayload` struct — the contract calls
 * `AttestationPayload::from_xdr(&env, &payload)` and then hashes those same
 * bytes with `keccak256`. So this is not a format we get to choose: it has to
 * be byte-identical to what `soroban_sdk`'s `to_xdr` produces on the Rust
 * side, or `from_xdr` rejects it and no signature is ever checked.
 *
 * ```rust
 * // contracts/invoice/src/types.rs
 * pub struct AttestationPayload {
 *     pub domain_separator: BytesN<32>,
 *     pub invoice_id: BytesN<32>,
 *     pub risk_score: u32,
 *     pub evidence_hash: BytesN<32>,
 *     pub agent_id: Symbol,
 *     pub nonce: u64,
 * }
 * ```
 *
 * A `#[contracttype]` struct encodes as an `ScVal::Map` whose keys are the
 * field names as `ScSymbol`, **sorted lexicographically** — not in
 * declaration order. That ordering was confirmed against a live deployed
 * contract rather than assumed: agent-registry's `get_agent` returns its
 * `Agent { active, pubkey }` struct as an `ScMap` with `active` before
 * `pubkey`. `BytesN<N>` encodes as `ScVal::Bytes`, also confirmed there.
 *
 * The digest that gets signed is `keccak256(payload)` over those XDR bytes.
 * Passing the whole payload rather than a bare hash is what lets the contract
 * check that the `invoice_id` inside it matches the argument it was called
 * with, so a signature cannot be lifted onto a different invoice.
 */

/**
 * The contract's fixed 32-byte domain separator, copied verbatim from
 * `ATTESTATION_DOMAIN_SEPARATOR` in `contracts/invoice/src/lib.rs`. Exactly
 * 32 ASCII bytes — the trailing underscore is padding to reach `BytesN<32>`,
 * not a typo. `submit_attestation` rejects any payload whose separator
 * differs, so this string is load-bearing.
 */
export const DOMAIN_SEPARATOR = "TrusTrove.InvoiceAttestation.v1_";

const INVOICE_ID_BYTES = 32;
const HASH_BYTES = 32;
const DOMAIN_SEPARATOR_BYTES = 32;
const MAX_AGENT_ID_BYTES = 32;
const MAX_RISK_SCORE = 10_000;
const MAX_U64 = (1n << 64n) - 1n;

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
  /**
   * The contract's `nonce` field is a `u64`, so this is a bigint, not bytes.
   * It is not tracked on-chain — the one-attestation-per-invoice storage
   * check is the actual replay guard.
   */
  nonce: bigint;
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

function assertAgentId(agentId: string): string {
  if (!/^[a-zA-Z0-9_]{1,32}$/.test(agentId)) {
    throw new AttestationError(
      `agentId "${agentId}" is not a valid Soroban Symbol (1-32 chars of [a-zA-Z0-9_])`,
    );
  }
  if (new TextEncoder().encode(agentId).length > MAX_AGENT_ID_BYTES) {
    throw new AttestationError("agentId exceeds 32 bytes");
  }
  return agentId;
}

/**
 * Builds the XDR-encoded `AttestationPayload` and the digest over it.
 *
 * The map entries are sorted by key before encoding. `soroban_sdk` emits
 * struct fields in lexicographic name order and its decoder depends on that
 * order, so building the entries in the struct's *declaration* order would
 * produce bytes that `from_xdr` rejects.
 */
export function buildAttestationPayload(fields: AttestationFields): {
  payload: `0x${string}`;
  digest: `0x${string}`;
} {
  const invoiceIdBytes = hexToBytes(
    fields.invoiceId,
    INVOICE_ID_BYTES,
    "invoiceId",
  );
  const evidenceHashBytes = hexToBytes(
    fields.evidenceHash,
    HASH_BYTES,
    "evidenceHash",
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

  if (fields.nonce < 0n || fields.nonce > MAX_U64) {
    throw new AttestationError(
      `nonce ${fields.nonce} does not fit in the contract's u64`,
    );
  }

  const domainSeparator = new TextEncoder().encode(DOMAIN_SEPARATOR);
  if (domainSeparator.length !== DOMAIN_SEPARATOR_BYTES) {
    // Guards against an edit to the constant silently producing payloads the
    // contract will reject for a reason that is hard to see from the outside.
    throw new AttestationError(
      `domain separator must be exactly ${DOMAIN_SEPARATOR_BYTES} bytes, got ${domainSeparator.length}`,
    );
  }

  const entries: Array<[string, xdr.ScVal]> = [
    ["domain_separator", xdr.ScVal.scvBytes(Buffer.from(domainSeparator))],
    ["invoice_id", xdr.ScVal.scvBytes(Buffer.from(invoiceIdBytes))],
    ["risk_score", nativeToScVal(fields.riskScore, { type: "u32" })],
    ["evidence_hash", xdr.ScVal.scvBytes(Buffer.from(evidenceHashBytes))],
    [
      "agent_id",
      nativeToScVal(assertAgentId(fields.agentId), { type: "symbol" }),
    ],
    ["nonce", nativeToScVal(fields.nonce, { type: "u64" })],
  ];

  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const scval = xdr.ScVal.scvMap(
    entries.map(
      ([key, val]) =>
        new xdr.ScMapEntry({
          key: nativeToScVal(key, { type: "symbol" }),
          val,
        }),
    ),
  );

  const preimage = new Uint8Array(scval.toXDR());
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
): bigint {
  const encoder = new TextEncoder();
  const digest = keccak256(
    encoder.encode(`${DOMAIN_SEPARATOR}|${agentId}|${invoiceId}|${evidenceHash}`),
  );
  // The contract's nonce is a u64, so the 32-byte digest is truncated to its
  // leading 8 bytes. Collision resistance is not what the nonce is for here —
  // replay is prevented by the contract's one-attestation-per-invoice storage
  // check — so 64 bits of a keccak digest is ample for making the value
  // unpredictable and deterministic.
  return BigInt(`0x${digest.slice(2, 18)}`);
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
