import { describe, expect, it } from "vitest";
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { keccak256, recoverPublicKey } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AttestationError,
  DOMAIN_SEPARATOR,
  buildAttestationPayload,
  canonicalize,
  deriveNonce,
  hashEvidenceReport,
  signAttestation,
} from "../src/attestation.js";
import type { AttestationFields } from "../src/attestation.js";

const PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

/**
 * A realistic TrusTrove invoice id: 32 raw bytes, with a leading zero byte
 * and interior zero bytes, both of which any numeric encoding would destroy.
 */
const INVOICE_ID =
  "0x00f3a10000000000000000000000000000000000000000000000000000000042" as const;

const fields: AttestationFields = {
  invoiceId: INVOICE_ID,
  riskScore: 1_250,
  evidenceHash: `0x${"ab".repeat(32)}`,
  agentId: "underwrite_v1",
  nonce: 42n,
};

/** Decodes a payload back into the ScVal the contract's `from_xdr` will see. */
function decode(payload: `0x${string}`): xdr.ScVal {
  return xdr.ScVal.fromXDR(Buffer.from(payload.slice(2), "hex"));
}

function entries(payload: `0x${string}`): Array<[string, xdr.ScVal]> {
  return decode(payload)
    .map()
    .map((e) => [e.key().sym().toString(), e.val()] as [string, xdr.ScVal]);
}

describe("buildAttestationPayload", () => {
  it("encodes an ScMap matching the contract's AttestationPayload struct", () => {
    const { payload } = buildAttestationPayload(fields);
    const decoded = decode(payload);

    expect(decoded.switch().name).toBe("scvMap");

    const byKey = new Map(entries(payload));
    expect([...byKey.keys()].sort()).toEqual([
      "agent_id",
      "domain_separator",
      "evidence_hash",
      "invoice_id",
      "nonce",
      "risk_score",
    ]);

    // Field types must match the Rust struct exactly, or from_xdr rejects.
    expect(byKey.get("domain_separator")?.switch().name).toBe("scvBytes");
    expect(byKey.get("invoice_id")?.switch().name).toBe("scvBytes");
    expect(byKey.get("evidence_hash")?.switch().name).toBe("scvBytes");
    expect(byKey.get("agent_id")?.switch().name).toBe("scvSymbol");
    expect(byKey.get("nonce")?.switch().name).toBe("scvU64");
    expect(byKey.get("risk_score")?.switch().name).toBe("scvU32");
  });

  it("orders map keys lexicographically, as soroban_sdk requires", () => {
    // Declaration order in the Rust struct is domain_separator, invoice_id,
    // risk_score, evidence_hash, agent_id, nonce. The wire order is NOT that.
    const keys = entries(buildAttestationPayload(fields).payload).map(
      ([k]) => k,
    );
    expect(keys).toEqual([...keys].sort());
    expect(keys).toEqual([
      "agent_id",
      "domain_separator",
      "evidence_hash",
      "invoice_id",
      "nonce",
      "risk_score",
    ]);
  });

  it("carries the contract's exact 32-byte domain separator", () => {
    expect(Buffer.from(DOMAIN_SEPARATOR, "ascii")).toHaveLength(32);
    expect(DOMAIN_SEPARATOR).toBe("TrusTrove.InvoiceAttestation.v1_");

    const byKey = new Map(entries(buildAttestationPayload(fields).payload));
    const separator = byKey.get("domain_separator");
    expect(separator?.bytes().toString("ascii")).toBe(DOMAIN_SEPARATOR);
  });

  it("copies invoice_id in verbatim, preserving leading and interior zeros", () => {
    const byKey = new Map(entries(buildAttestationPayload(fields).payload));
    const encoded = byKey.get("invoice_id")?.bytes();

    expect(encoded?.toString("hex")).toBe(INVOICE_ID.slice(2));
    expect(encoded).toHaveLength(32);
    expect(encoded?.[0]).toBe(0x00);
  });

  it("round-trips every field back to its input value", () => {
    const decoded = scValToNative(
      decode(buildAttestationPayload(fields).payload),
    ) as Record<string, unknown>;

    expect(decoded["risk_score"]).toBe(1_250);
    expect(decoded["nonce"]).toBe(42n);
    expect(decoded["agent_id"]).toBe("underwrite_v1");
    expect(Buffer.from(decoded["invoice_id"] as Uint8Array).toString("hex")).toBe(
      INVOICE_ID.slice(2),
    );
  });

  it("digests the payload with keccak256", () => {
    const { payload, digest } = buildAttestationPayload(fields);
    expect(digest).toBe(keccak256(payload));
  });

  it("is deterministic", () => {
    expect(buildAttestationPayload(fields)).toEqual(
      buildAttestationPayload({ ...fields }),
    );
  });

  it("produces a different digest for a different risk score", () => {
    expect(buildAttestationPayload(fields).digest).not.toBe(
      buildAttestationPayload({ ...fields, riskScore: 1_251 }).digest,
    );
  });

  it("distinguishes ids that a numeric encoding would collapse together", () => {
    // Different BytesN<32> values, same integer. Under a numeric encoding both
    // would digest identically and an attestation for one invoice would verify
    // against the other.
    const a = buildAttestationPayload({
      ...fields,
      invoiceId: `0x${"00".repeat(31)}2a`,
    });
    const b = buildAttestationPayload({
      ...fields,
      invoiceId: `0x${"00".repeat(30)}2a00`,
    });
    expect(a.digest).not.toBe(b.digest);
  });

  it("changes the digest when any single invoice id byte changes", () => {
    const baseBytes = Buffer.from(INVOICE_ID.slice(2), "hex");
    const baseDigest = buildAttestationPayload(fields).digest;

    for (let index = 0; index < baseBytes.length; index++) {
      const changed = Buffer.from(baseBytes);
      changed[index] ^= 0xff;
      const invoiceId = `0x${changed.toString("hex")}` as const;

      expect(buildAttestationPayload({ ...fields, invoiceId }).digest).not.toBe(
        baseDigest,
      );
    }
  });

  it("rejects a risk score outside the basis point range", () => {
    expect(() =>
      buildAttestationPayload({ ...fields, riskScore: 10_001 }),
    ).toThrow(AttestationError);
    expect(() => buildAttestationPayload({ ...fields, riskScore: -1 })).toThrow(
      AttestationError,
    );
  });

  it("rejects a fractional risk score", () => {
    expect(() =>
      buildAttestationPayload({ ...fields, riskScore: 1_250.5 }),
    ).toThrow(/integer/);
  });

  it("rejects an invoice id that is not exactly 32 bytes", () => {
    expect(() =>
      buildAttestationPayload({ ...fields, invoiceId: "0x" }),
    ).toThrow(/32 bytes/);
    expect(() =>
      buildAttestationPayload({ ...fields, invoiceId: `0x${"ab".repeat(31)}` }),
    ).toThrow(/32 bytes/);
    expect(() =>
      buildAttestationPayload({ ...fields, invoiceId: `0x${"ab".repeat(33)}` }),
    ).toThrow(/32 bytes/);
  });

  it("rejects a decimal invoice id outright rather than coercing it", () => {
    expect(() =>
      buildAttestationPayload({ ...fields, invoiceId: "42" as `0x${string}` }),
    ).toThrow(/0x-prefixed hex/);
  });

  it("rejects an agent id outside the Soroban Symbol charset", () => {
    expect(() =>
      buildAttestationPayload({ ...fields, agentId: "under-write" }),
    ).toThrow(/Symbol/);
  });

  it("rejects a nonce that does not fit in the contract's u64", () => {
    expect(() =>
      buildAttestationPayload({ ...fields, nonce: 1n << 64n }),
    ).toThrow(/u64/);
    expect(() => buildAttestationPayload({ ...fields, nonce: -1n })).toThrow(
      /u64/,
    );
  });

  it("rejects a mis-sized evidence hash", () => {
    expect(() =>
      buildAttestationPayload({ ...fields, evidenceHash: "0xabcd" }),
    ).toThrow(/32 bytes/);
  });
});

/**
 * Cross-implementation parity with the Soroban side.
 *
 * The contract calls `AttestationPayload::from_xdr(&payload)` and then
 * `keccak256(&payload)`. Two things therefore have to hold:
 *
 * 1. `keccak256` here is genuine Keccak-256, not SHA3-256 — the two differ
 *    only in padding and produce entirely different digests, so this is
 *    checked against published vectors rather than against another viem call.
 * 2. The bytes decode as the contract's struct. The decoding below uses
 *    stellar-sdk's XDR reader, and the same bytes were additionally decoded
 *    by the `stellar` CLI's independent Rust implementation during
 *    development, which produced the six sorted symbol keys with types
 *    symbol/bytes/bytes/bytes/u64/u32.
 */
describe("Rust/Soroban parity", () => {
  it("uses Keccak-256, not SHA3-256", () => {
    expect(keccak256(new Uint8Array())).toBe(
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
    expect(keccak256(new TextEncoder().encode("abc"))).toBe(
      "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    );
  });

  it("matches the XDR the stellar CLI decoded during verification", () => {
    // Pinned from a run whose output was decoded by the `stellar xdr decode`
    // Rust implementation into the correct AttestationPayload shape. If this
    // changes, the wire format changed and the contract will reject it.
    const pinned: AttestationFields = {
      invoiceId: `0x${"7f".repeat(32)}`,
      riskScore: 1_250,
      evidenceHash: `0x${"ab".repeat(32)}`,
      agentId: "underwrite_v1",
      nonce: 42n,
    };
    const { payload, digest } = buildAttestationPayload(pinned);

    expect(Buffer.from(payload.slice(2), "hex").toString("base64")).toBe(
      "AAAAEQAAAAEAAAAGAAAADwAAAAhhZ2VudF9pZAAAAA8AAAANdW5kZXJ3cml0ZV92MQAAAAAAAA8AAAAQZG9tYWluX3NlcGFyYXRvcgAAAA0AAAAgVHJ1c1Ryb3ZlLkludm9pY2VBdHRlc3RhdGlvbi52MV8AAAAPAAAADWV2aWRlbmNlX2hhc2gAAAAAAAANAAAAIKurq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urAAAADwAAAAppbnZvaWNlX2lkAAAAAAANAAAAIH9/f39/f39/f39/f39/f39/f39/f39/f39/f39/f39/AAAADwAAAAVub25jZQAAAAAAAAUAAAAAAAAAKgAAAA8AAAAKcmlza19zY29yZQAAAAAAAwAABOI=",
    );
    expect(digest).toBe(
      "0x3acae65b18a83107fee0b83ce8bf9fd265da3cf84e178c861a6b7b3579e01624",
    );
  });

  it("produces bytes that re-parse as a valid ScVal", () => {
    // A malformed encoding would throw here, which is exactly what the
    // contract's from_xdr would do before any signature is examined.
    expect(() => decode(buildAttestationPayload(fields).payload)).not.toThrow();
  });
});

describe("signAttestation", () => {
  it("produces a 65-byte signature whose key recovers to the agent", async () => {
    const signed = await signAttestation(fields, PRIVATE_KEY);

    expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect([0, 1]).toContain(signed.recoveryId);

    const recovered = await recoverPublicKey({
      hash: signed.digest,
      signature: signed.signature,
    });
    expect(recovered.toLowerCase()).toBe(
      privateKeyToAccount(PRIVATE_KEY).publicKey.toLowerCase(),
    );
  });

  it("packs the recovery id as 0 or 1, not 27 or 28", async () => {
    // The contract does `sig_bytes[64] as u32` and hands that straight to
    // secp256k1_recover, which rejects anything above 1.
    const signed = await signAttestation(fields, PRIVATE_KEY);
    const lastByte = Number.parseInt(signed.signature.slice(-2), 16);
    expect(lastByte).toBe(signed.recoveryId);
    expect(lastByte).toBeLessThan(2);
  });

  it("is deterministic for the same inputs (RFC 6979)", async () => {
    const a = await signAttestation(fields, PRIVATE_KEY);
    const b = await signAttestation(fields, PRIVATE_KEY);
    expect(a.signature).toBe(b.signature);
  });
});

describe("canonicalize", () => {
  it("orders keys independently of insertion order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("renders bigints as decimal strings", () => {
    expect(canonicalize({ amount: 10n })).toBe('{"amount":"10"}');
  });

  it("drops undefined fields so omission and undefined hash alike", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("hashEvidenceReport", () => {
  const report = {
    invoiceId: INVOICE_ID,
    agentId: "underwrite_v1",
    riskScore: 1_250,
    generatedAt: "2026-01-06T00:00:00.000Z",
    sources: {},
    scoreBreakdown: {},
  } as unknown as Parameters<typeof hashEvidenceReport>[0];

  it("ignores the evidenceHash field itself", () => {
    expect(
      hashEvidenceReport({ ...report, evidenceHash: `0x${"11".repeat(32)}` }),
    ).toBe(hashEvidenceReport(report));
  });

  it("changes when any other field changes", () => {
    expect(hashEvidenceReport({ ...report, riskScore: 1_251 })).not.toBe(
      hashEvidenceReport(report),
    );
  });
});

describe("deriveNonce", () => {
  it("returns a value inside the contract's u64 range", () => {
    const nonce = deriveNonce("agent", INVOICE_ID, fields.evidenceHash);
    expect(typeof nonce).toBe("bigint");
    expect(nonce).toBeGreaterThanOrEqual(0n);
    expect(nonce).toBeLessThan(1n << 64n);
  });

  it("is stable for the same invoice and evidence", () => {
    expect(deriveNonce("agent", INVOICE_ID, fields.evidenceHash)).toBe(
      deriveNonce("agent", INVOICE_ID, fields.evidenceHash),
    );
  });

  it("differs across invoices and across evidence", () => {
    const base = deriveNonce("agent", INVOICE_ID, fields.evidenceHash);
    expect(deriveNonce("agent", `0x${"01".repeat(32)}`, fields.evidenceHash)).not.toBe(
      base,
    );
    expect(deriveNonce("agent", INVOICE_ID, `0x${"ff".repeat(32)}`)).not.toBe(
      base,
    );
  });
});
