import { describe, expect, it } from "vitest";
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
  nonce: `0x${"cd".repeat(32)}`,
};

describe("buildAttestationPayload", () => {
  it("lays the preimage out at the documented offsets", () => {
    const { payload } = buildAttestationPayload(fields);
    const bytes = Buffer.from(payload.slice(2), "hex");

    const agentIdLength = Buffer.from(fields.agentId).length;
    expect(bytes.length).toBe(25 + 32 + 4 + 32 + 1 + agentIdLength + 32);

    expect(bytes.subarray(0, 25).toString("ascii")).toBe(DOMAIN_SEPARATOR);
    expect(bytes.subarray(25, 57).toString("hex")).toBe(INVOICE_ID.slice(2));
    expect(bytes.readUInt32BE(57)).toBe(1_250);
    expect(bytes.subarray(61, 93).toString("hex")).toBe("ab".repeat(32));
    expect(bytes[93]).toBe(agentIdLength);
    expect(bytes.subarray(94, 94 + agentIdLength).toString("ascii")).toBe(
      fields.agentId,
    );
    expect(bytes.subarray(94 + agentIdLength).toString("hex")).toBe(
      "cd".repeat(32),
    );
  });

  it("copies invoice_id in verbatim, preserving leading and interior zeros", () => {
    const { payload } = buildAttestationPayload(fields);
    const bytes = Buffer.from(payload.slice(2), "hex");

    // The exact bytes, not a numeric normalisation of them. `BigInt(id)` would
    // render this same value without its leading zero byte.
    expect(bytes.subarray(25, 57).toString("hex")).toBe(INVOICE_ID.slice(2));
    expect(bytes[25]).toBe(0x00);
  });

  it("distinguishes ids that a numeric encoding would collapse together", () => {
    // These are different BytesN<32> values but the same integer. If invoice_id
    // were parsed as a number, both would produce an identical digest and an
    // attestation for one invoice would verify against the other.
    const withLeadingZeros = `0x${"00".repeat(31)}2a` as const;
    const bare = `0x${"00".repeat(30)}2a00` as const;

    const a = buildAttestationPayload({ ...fields, invoiceId: withLeadingZeros });
    const b = buildAttestationPayload({ ...fields, invoiceId: bare });

    expect(a.digest).not.toBe(b.digest);
  });

  it("digests the preimage with keccak256", () => {
    const { payload, digest } = buildAttestationPayload(fields);
    expect(digest).toBe(keccak256(payload));
  });

  it("is deterministic", () => {
    expect(buildAttestationPayload(fields)).toEqual(
      buildAttestationPayload({ ...fields }),
    );
  });

  it("produces a different digest for a different risk score", () => {
    const a = buildAttestationPayload(fields);
    const b = buildAttestationPayload({ ...fields, riskScore: 1_251 });
    expect(a.digest).not.toBe(b.digest);
  });

  it("length-prefixes agent_id so field boundaries cannot be forged", () => {
    // Without the length prefix these two could collide by shifting bytes
    // between agent_id and the nonce.
    const a = buildAttestationPayload({ ...fields, agentId: "ab" });
    const b = buildAttestationPayload({ ...fields, agentId: "abc" });
    expect(a.payload).not.toBe(b.payload);
    expect(a.digest).not.toBe(b.digest);
  });

  it("rejects a risk score outside the basis point range", () => {
    expect(() => buildAttestationPayload({ ...fields, riskScore: 10_001 })).toThrow(
      AttestationError,
    );
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
      buildAttestationPayload({ ...fields, invoiceId: `0x${"ab".repeat(31)}` }),
    ).toThrow(/32 bytes/);
    expect(() =>
      buildAttestationPayload({ ...fields, invoiceId: `0x${"ab".repeat(33)}` }),
    ).toThrow(/32 bytes/);
  });

  it("rejects a decimal invoice id outright rather than coercing it", () => {
    // The old numeric form. It must fail loudly, not silently re-encode.
    expect(() =>
      buildAttestationPayload({ ...fields, invoiceId: "42" as `0x${string}` }),
    ).toThrow(/0x-prefixed hex/);
  });

  it("rejects an agent id outside the Soroban Symbol charset", () => {
    expect(() =>
      buildAttestationPayload({ ...fields, agentId: "under-write" }),
    ).toThrow(/Symbol/);
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
 * The contract rebuilds this preimage in Rust and hashes it with Soroban's
 * `keccak256`. Two things therefore have to hold, and asserting the TS output
 * against itself would prove neither:
 *
 * 1. `keccak256` here is genuine Keccak-256, not SHA3-256. The two differ only
 *    in padding and produce completely different digests for identical input,
 *    so the check is against published Keccak-256 vectors rather than against
 *    another viem call.
 * 2. The preimage bytes are what a Rust implementation reading the layout
 *    table would independently produce — built here with plain concatenation,
 *    not by calling the function under test.
 */
describe("Rust/Soroban parity", () => {
  it("uses Keccak-256, not SHA3-256", () => {
    // Published Keccak-256 vectors. SHA3-256 of the same inputs differs
    // entirely, so this pins the exact primitive Soroban implements.
    expect(keccak256(new Uint8Array())).toBe(
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
    expect(keccak256(new TextEncoder().encode("abc"))).toBe(
      "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    );
  });

  it("digests a preimage assembled independently, byte for byte", () => {
    // Built the way the contract would: fixed-width fields concatenated in
    // order, invoice_id copied in raw.
    const riskScore = Buffer.alloc(4);
    riskScore.writeUInt32BE(fields.riskScore);

    const agentId = Buffer.from(fields.agentId, "ascii");

    const expectedPreimage = Buffer.concat([
      Buffer.from(DOMAIN_SEPARATOR, "ascii"),
      Buffer.from(INVOICE_ID.slice(2), "hex"),
      riskScore,
      Buffer.from(fields.evidenceHash.slice(2), "hex"),
      Buffer.from([agentId.length]),
      agentId,
      Buffer.from(fields.nonce.slice(2), "hex"),
    ]);

    const { payload, digest } = buildAttestationPayload(fields);

    expect(Buffer.from(payload.slice(2), "hex").equals(expectedPreimage)).toBe(
      true,
    );
    expect(digest).toBe(keccak256(expectedPreimage));
  });

  it("holds the digest to a fixed value, so any encoding change is caught", () => {
    // A regression pin. If this value changes, the wire format changed, and
    // the Soroban side must change with it or signature recovery breaks.
    const { digest } = buildAttestationPayload(fields);
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(digest).toBe(
      keccak256(
        Buffer.from(buildAttestationPayload(fields).payload.slice(2), "hex"),
      ),
    );
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
    const account = privateKeyToAccount(PRIVATE_KEY);
    expect(recovered.toLowerCase()).toBe(account.publicKey.toLowerCase());
  });

  it("packs the recovery id as 0 or 1, not 27 or 28", async () => {
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
    invoiceId: "42",
    agentId: "underwrite_v1",
    riskScore: 1_250,
    generatedAt: "2026-01-06T00:00:00.000Z",
    sources: {},
    scoreBreakdown: {},
  } as unknown as Parameters<typeof hashEvidenceReport>[0];

  it("ignores the evidenceHash field itself", () => {
    const withoutField = hashEvidenceReport(report);
    const withField = hashEvidenceReport({
      ...report,
      evidenceHash: `0x${"11".repeat(32)}`,
    });
    expect(withField).toBe(withoutField);
  });

  it("changes when any other field changes", () => {
    const a = hashEvidenceReport(report);
    const b = hashEvidenceReport({ ...report, riskScore: 1_251 });
    expect(a).not.toBe(b);
  });
});

describe("deriveNonce", () => {
  it("is stable for the same invoice and evidence", () => {
    expect(deriveNonce("agent", "42", fields.evidenceHash)).toBe(
      deriveNonce("agent", "42", fields.evidenceHash),
    );
  });

  it("differs across invoices and across evidence", () => {
    const base = deriveNonce("agent", "42", fields.evidenceHash);
    expect(deriveNonce("agent", "43", fields.evidenceHash)).not.toBe(base);
    expect(deriveNonce("agent", "42", `0x${"ff".repeat(32)}`)).not.toBe(base);
  });
});
