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

const fields: AttestationFields = {
  invoiceId: "42",
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
    expect(bytes.length).toBe(25 + 16 + 4 + 32 + 1 + agentIdLength + 32);

    expect(bytes.subarray(0, 25).toString("ascii")).toBe(DOMAIN_SEPARATOR);
    expect(bytes.readBigUInt64BE(25)).toBe(0n); // high 8 bytes of the u128
    expect(bytes.readBigUInt64BE(33)).toBe(42n); // low 8 bytes
    expect(bytes.readUInt32BE(41)).toBe(1_250);
    expect(bytes.subarray(45, 77).toString("hex")).toBe("ab".repeat(32));
    expect(bytes[77]).toBe(agentIdLength);
    expect(bytes.subarray(78, 78 + agentIdLength).toString("ascii")).toBe(
      fields.agentId,
    );
    expect(bytes.subarray(78 + agentIdLength).toString("hex")).toBe(
      "cd".repeat(32),
    );
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

  it("rejects an invoice id that does not fit in a u128", () => {
    expect(() =>
      buildAttestationPayload({ ...fields, invoiceId: (2n ** 128n).toString() }),
    ).toThrow(/16 bytes/);
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
