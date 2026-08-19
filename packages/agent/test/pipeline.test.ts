import { describe, expect, it } from "vitest";
import { keccak256, recoverPublicKey } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { verifyInvoice } from "../src/pipeline.js";
import type { PipelineDeps } from "../src/pipeline.js";
import { MemoryEvidenceStore } from "../src/evidenceStore.js";
import { canonicalize, hashEvidenceReport } from "../src/attestation.js";
import type { WebSearchProvider } from "../src/sources/webResearch.js";
import type { VerificationRequest } from "../src/types.js";

const PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

/** A structurally real, clean PDF. */
const CLEAN_PDF = new TextEncoder().encode(
  "%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Info << /Producer (Acme Accounting 4.1) /CreationDate (D:20260105093000Z) >> >>\n%%EOF\n",
);

function request(): VerificationRequest {
  return {
    invoiceId: "42",
    document: CLEAN_PDF,
    documentFilename: "invoice.pdf",
    amountMinor: 500_000_00n,
    currency: "NGN",
    invoiceDate: "2026-01-05",
    dueDate: "2026-03-05",
    buyer: { address: "GBUYER", name: "Zenith Foods Ltd", rcNumber: "RC111" },
    seller: { address: "GSELLER", name: "Kanem Logistics", rcNumber: "RC222" },
  };
}

const emptySearch: WebSearchProvider = { name: "stub", search: async () => [] };

const failingSearch: WebSearchProvider = {
  name: "stub",
  search: async () => {
    throw new Error("search provider down");
  },
};

const goodHistory = (address: string) => ({
  address,
  totalInvoices: 8,
  repaidInvoices: 8,
  defaultedInvoices: 0,
  lateInvoices: 0,
  averageDaysLate: 1,
});

function deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    platformHistory: { TRUSTROVE_INDEXER_URL: "https://indexer.example" },
    cacLookup: {
      CAC_LOOKUP_PROVIDER: "dojah",
      CAC_LOOKUP_BASE_URL: "https://cac.example",
      CAC_LOOKUP_API_KEY: "k",
    },
    searchProvider: emptySearch,
    evidenceStore: new MemoryEvidenceStore(),
    agentId: "underwrite_v1",
    privateKey: PRIVATE_KEY,
    now: () => new Date("2026-01-06T00:00:00.000Z"),
    ...overrides,
  };
}

/**
 * The pipeline calls the real source modules, which call the real HTTP client.
 * Stubbing global fetch keeps the whole path under test rather than replacing
 * the sources with mocks.
 */
function stubFetch(handler: (url: string) => unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = handler(url);
    if (body instanceof Error) throw body;
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const happyRoutes = (url: string): unknown => {
  if (url.includes("by-document-hash")) return { invoiceIds: [] };
  if (url.includes("GSELLER")) return goodHistory("GSELLER");
  if (url.includes("GBUYER")) return goodHistory("GBUYER");
  if (url.includes("cac.example")) {
    return {
      entity: {
        company_name: "ZENITH FOODS LIMITED",
        company_status: "ACTIVE",
        date_of_registration: "2015-04-01",
      },
    };
  }
  throw new Error(`unrouted ${url}`);
};

describe("verifyInvoice", () => {
  it("produces a signed attestation over a stored report", async () => {
    const restore = stubFetch(happyRoutes);
    try {
      const store = new MemoryEvidenceStore();
      const outcome = await verifyInvoice(request(), deps({ evidenceStore: store }));

      expect(outcome.status).toBe("attested");
      if (outcome.status !== "attested") return;

      // The attestation commits to the score and the report that justifies it.
      expect(outcome.attestation.riskScore).toBe(outcome.report.riskScore);
      expect(outcome.attestation.evidenceHash).toBe(outcome.report.evidenceHash);
      expect(outcome.attestation.agentId).toBe("underwrite_v1");

      // The report is retrievable by the hash that went on-chain.
      const stored = await store.get(outcome.report.evidenceHash);
      expect(stored).not.toBeNull();

      // The signature really is the agent's, over the payload it claims.
      expect(outcome.attestation.digest).toBe(keccak256(outcome.attestation.payload));
      const recovered = await recoverPublicKey({
        hash: outcome.attestation.digest,
        signature: outcome.attestation.signature,
      });
      expect(recovered.toLowerCase()).toBe(
        privateKeyToAccount(PRIVATE_KEY).publicKey.toLowerCase(),
      );
    } finally {
      restore();
    }
  });

  it("produces an evidence hash a third party can recompute from the report", async () => {
    const restore = stubFetch(happyRoutes);
    try {
      const outcome = await verifyInvoice(request(), deps());
      if (outcome.status !== "attested") throw new Error("expected attested");

      // A verifier holding only the stored report must arrive at the same hash.
      expect(hashEvidenceReport(outcome.report)).toBe(outcome.report.evidenceHash);
      // And the stored bytes are the canonical ones that were hashed.
      expect(canonicalize(outcome.report)).toContain(outcome.report.evidenceHash);
    } finally {
      restore();
    }
  });

  it("records every source's status in the report", async () => {
    const restore = stubFetch(happyRoutes);
    try {
      const outcome = await verifyInvoice(request(), deps());
      if (outcome.status !== "attested") throw new Error("expected attested");

      expect(outcome.report.sources.platformHistory.status).toBe("ok");
      expect(outcome.report.sources.cacLookup.status).toBe("ok");
      expect(outcome.report.sources.webResearch.status).toBe("ok");
      expect(outcome.report.sources.documentForensics.status).toBe("ok");
    } finally {
      restore();
    }
  });

  it("still attests when only the optional source is down, with a penalty", async () => {
    const restore = stubFetch(happyRoutes);
    try {
      const clean = await verifyInvoice(request(), deps());
      const degraded = await verifyInvoice(
        request(),
        deps({ searchProvider: failingSearch }),
      );

      if (clean.status !== "attested" || degraded.status !== "attested") {
        throw new Error("expected both to attest");
      }

      expect(degraded.report.sources.webResearch.status).toBe("unavailable");
      expect(degraded.report.riskScore).toBeGreaterThan(clean.report.riskScore);
      expect(degraded.report.scoreBreakdown.unavailabilityPenaltyBps).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it("refuses to sign anything when a required source is down", async () => {
    const restore = stubFetch((url) => {
      if (url.includes("cac.example")) return new Error("provider 503");
      return happyRoutes(url);
    });
    try {
      const store = new MemoryEvidenceStore();
      const outcome = await verifyInvoice(request(), deps({ evidenceStore: store }));

      expect(outcome.status).toBe("insufficient_evidence");
      if (outcome.status !== "insufficient_evidence") return;

      expect(outcome.missing).toContain("cacLookup");
      expect(outcome.report.riskScore).toBeNull();
      expect(outcome).not.toHaveProperty("attestation");

      // A refused verification is still auditable.
      const stored = await store.get(outcome.report.evidenceHash);
      expect(stored).not.toBeNull();
      expect(outcome.report.sources.cacLookup.status).toBe("unavailable");
    } finally {
      restore();
    }
  });

  it("is deterministic: the same invoice and evidence give the same signature", async () => {
    const restore = stubFetch(happyRoutes);
    try {
      const a = await verifyInvoice(request(), deps());
      const b = await verifyInvoice(request(), deps());
      if (a.status !== "attested" || b.status !== "attested") {
        throw new Error("expected attested");
      }
      expect(a.attestation.signature).toBe(b.attestation.signature);
      expect(a.report.evidenceHash).toBe(b.report.evidenceHash);
    } finally {
      restore();
    }
  });

  it("raises the signal and still attests when the document looks tampered with", async () => {
    const restore = stubFetch(happyRoutes);
    try {
      const tampered = {
        ...request(),
        document: new TextEncoder().encode(
          "%PDF-1.7\n1 0 obj << /Subtype /FreeText >> endobj\ntrailer << /Info << /Producer (Acme Accounting 4.1) /CreationDate (D:20260105093000Z) >> >>\n%%EOF\ntrailer << /Info << /Producer (Adobe Photoshop 25.0) >> >>\n%%EOF\n",
        ),
      };
      const clean = await verifyInvoice(request(), deps());
      const dirty = await verifyInvoice(tampered, deps());

      if (clean.status !== "attested" || dirty.status !== "attested") {
        throw new Error("expected attested");
      }
      expect(dirty.report.riskScore).toBeGreaterThan(clean.report.riskScore);
    } finally {
      restore();
    }
  });
});
