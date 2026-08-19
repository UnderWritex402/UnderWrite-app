import { describe, expect, it } from "vitest";
import {
  BPS,
  SOURCE_WEIGHTS_BPS,
  scoreCacLookup,
  scoreDocumentForensics,
  scoreInvoice,
  scorePlatformHistory,
  scoreWebResearch,
} from "../src/scoring.js";
import type { SourceInputs } from "../src/scoring.js";
import { ok, unavailable } from "../src/types.js";
import type {
  CacLookupResult,
  DocumentForensicsResult,
  PlatformHistoryResult,
  VerificationRequest,
  WebResearchResult,
} from "../src/types.js";

const request: VerificationRequest = {
  invoiceId: "inv-1",
  document: new Uint8Array([1]),
  documentFilename: "invoice.pdf",
  amountMinor: 500_000_00n,
  currency: "NGN",
  invoiceDate: "2026-01-05",
  dueDate: "2026-03-05",
  buyer: { address: "GBUYER", name: "Zenith Foods Limited", rcNumber: "RC111" },
  seller: { address: "GSELLER", name: "Kanem Logistics", rcNumber: "RC222" },
};

const goodHistory: PlatformHistoryResult = {
  duplicateInvoice: false,
  duplicateOfInvoiceIds: [],
  coldStart: false,
  buyer: {
    address: "GBUYER",
    totalInvoices: 8,
    repaidInvoices: 8,
    defaultedInvoices: 0,
    lateInvoices: 0,
    averageDaysLate: 1,
  },
  seller: {
    address: "GSELLER",
    totalInvoices: 6,
    repaidInvoices: 6,
    defaultedInvoices: 0,
    lateInvoices: 0,
    averageDaysLate: 0,
  },
};

const goodCac: CacLookupResult = {
  rcNumber: "RC111",
  registered: true,
  registeredName: "Zenith Foods Limited",
  status: "ACTIVE",
  registrationDate: "2015-04-01",
  nameMismatch: false,
  provider: "dojah",
};

const cleanDocument: DocumentForensicsResult = {
  fileType: "pdf",
  documentHash: "a".repeat(64),
  signals: [],
  metadata: {
    producer: "Acme Accounting",
    creator: null,
    creationDate: "2026-01-05T09:00:00.000Z",
    modificationDate: null,
    eofMarkers: 1,
    pdfVersion: "1.7",
  },
};

const cleanWeb: WebResearchResult = {
  queries: ["a", "b"],
  findings: [],
  sourcesConsulted: 12,
};

function inputs(overrides: Partial<SourceInputs> = {}): SourceInputs {
  return {
    platformHistory: ok(goodHistory),
    cacLookup: ok(goodCac),
    documentForensics: ok(cleanDocument),
    webResearch: ok(cleanWeb),
    ...overrides,
  };
}

describe("source weights", () => {
  it("sum to exactly 10000 basis points", () => {
    const total = Object.values(SOURCE_WEIGHTS_BPS).reduce((a, b) => a + b, 0);
    expect(total).toBe(BPS);
  });
});

describe("scoreInvoice", () => {
  it("produces a low integer signal for a clean invoice", () => {
    const outcome = scoreInvoice(request, inputs());
    expect(outcome.status).toBe("scored");
    if (outcome.status !== "scored") return;
    expect(Number.isInteger(outcome.riskScore)).toBe(true);
    expect(outcome.riskScore).toBeGreaterThanOrEqual(0);
    expect(outcome.riskScore).toBeLessThan(2_000);
    expect(outcome.breakdown.answeredWeightBps).toBe(BPS);
    expect(outcome.breakdown.unavailabilityPenaltyBps).toBe(0);
  });

  it("refuses to score when a required source is unavailable", () => {
    const outcome = scoreInvoice(
      request,
      inputs({ cacLookup: unavailable("provider 503") }),
    );
    expect(outcome.status).toBe("insufficient_evidence");
    if (outcome.status !== "insufficient_evidence") return;
    expect(outcome.missing).toEqual(["cacLookup"]);
    expect(outcome).not.toHaveProperty("riskScore");
    // The breakdown still explains itself, so the caller can report why.
    expect(outcome.breakdown.notes.join(" ")).toContain("cacLookup");
  });

  it("still scores without web research, but charges a penalty", () => {
    const clean = scoreInvoice(request, inputs());
    const degraded = scoreInvoice(
      request,
      inputs({ webResearch: unavailable("search provider timed out") }),
    );
    expect(degraded.status).toBe("scored");
    if (degraded.status !== "scored" || clean.status !== "scored") return;

    expect(degraded.breakdown.answeredWeightBps).toBe(
      BPS - SOURCE_WEIGHTS_BPS.webResearch,
    );
    expect(degraded.breakdown.unavailabilityPenaltyBps).toBeGreaterThan(0);
    // Missing evidence must never make an invoice look better.
    expect(degraded.riskScore).toBeGreaterThan(clean.riskScore);
  });

  it("clamps the signal to the 0-10000 range", () => {
    const outcome = scoreInvoice(
      request,
      inputs({
        platformHistory: ok({
          ...goodHistory,
          duplicateInvoice: true,
          duplicateOfInvoiceIds: ["inv-0"],
        }),
        cacLookup: ok({ ...goodCac, registered: false }),
        documentForensics: ok({
          ...cleanDocument,
          signals: [
            { code: "multiple_producers", detail: "x", severity: 100 },
            { code: "incremental_update", detail: "y", severity: 100 },
          ],
        }),
        webResearch: ok({
          ...cleanWeb,
          findings: [
            {
              subject: "buyer",
              category: "fraud",
              summary: "convicted",
              url: "https://e/1",
              publishedAt: null,
              confidence: 100,
            },
          ],
        }),
      }),
    );
    if (outcome.status !== "scored") throw new Error("expected scored");
    expect(outcome.riskScore).toBeLessThanOrEqual(BPS);
    expect(outcome.riskScore).toBeGreaterThan(8_000);
  });
});

describe("scorePlatformHistory", () => {
  it("maxes out on a duplicate invoice regardless of other history", () => {
    const { subScoreBps } = scorePlatformHistory({
      ...goodHistory,
      duplicateInvoice: true,
      duplicateOfInvoiceIds: ["inv-0"],
    });
    expect(subScoreBps).toBe(BPS);
  });

  it("scores cold start as unproven, not clean", () => {
    const empty = {
      address: "G",
      totalInvoices: 0,
      repaidInvoices: 0,
      defaultedInvoices: 0,
      lateInvoices: 0,
      averageDaysLate: null,
    };
    const cold = scorePlatformHistory({
      duplicateInvoice: false,
      duplicateOfInvoiceIds: [],
      coldStart: true,
      buyer: empty,
      seller: empty,
    });
    const known = scorePlatformHistory(goodHistory);
    expect(cold.subScoreBps).toBe(5_000);
    expect(cold.subScoreBps).toBeGreaterThan(known.subScoreBps);
  });

  it("penalises a buyer with defaults", () => {
    const risky = scorePlatformHistory({
      ...goodHistory,
      buyer: {
        ...goodHistory.buyer,
        totalInvoices: 4,
        repaidInvoices: 2,
        defaultedInvoices: 2,
      },
    });
    expect(risky.subScoreBps).toBeGreaterThan(
      scorePlatformHistory(goodHistory).subScoreBps,
    );
    expect(risky.reasons.join(" ")).toContain("defaulted");
  });
});

describe("scoreCacLookup", () => {
  it("scores an unregistered counterparty as near-maximum risk", () => {
    const { subScoreBps } = scoreCacLookup(
      { ...goodCac, registered: false },
      request,
    );
    expect(subScoreBps).toBe(9_500);
  });

  it("penalises a name mismatch", () => {
    const { subScoreBps, reasons } = scoreCacLookup(
      { ...goodCac, nameMismatch: true, registeredName: "Zenith Foods Nig" },
      request,
    );
    expect(subScoreBps).toBeGreaterThan(3_000);
    expect(reasons.join(" ")).toContain("does not match");
  });

  it("penalises a company registered just before the invoice date", () => {
    const { subScoreBps } = scoreCacLookup(
      { ...goodCac, registrationDate: "2025-12-01" },
      request,
    );
    expect(subScoreBps).toBeGreaterThan(
      scoreCacLookup(goodCac, request).subScoreBps,
    );
  });
});

describe("scoreDocumentForensics", () => {
  it("lets the strongest signal dominate rather than summing weak ones", () => {
    const oneStrong = scoreDocumentForensics({
      ...cleanDocument,
      signals: [{ code: "multiple_producers", detail: "d", severity: 90 }],
    });
    const manyWeak = scoreDocumentForensics({
      ...cleanDocument,
      signals: [
        { code: "missing_metadata", detail: "d", severity: 20 },
        { code: "encrypted_document", detail: "d", severity: 20 },
        { code: "producer_mismatch", detail: "d", severity: 20 },
        { code: "annotation_overlay", detail: "d", severity: 20 },
      ],
    });
    expect(oneStrong.subScoreBps).toBeGreaterThan(manyWeak.subScoreBps);
  });

  it("does not score a clean document as zero risk", () => {
    const { subScoreBps } = scoreDocumentForensics(cleanDocument);
    expect(subScoreBps).toBe(500);
  });
});

describe("scoreWebResearch", () => {
  it("weighs fraud above litigation at equal confidence", () => {
    const finding = (category: "fraud" | "litigation") => ({
      subject: "buyer" as const,
      category,
      summary: "s",
      url: "https://e/1",
      publishedAt: null,
      confidence: 80,
    });
    expect(
      scoreWebResearch({ ...cleanWeb, findings: [finding("fraud")] }).subScoreBps,
    ).toBeGreaterThan(
      scoreWebResearch({ ...cleanWeb, findings: [finding("litigation")] })
        .subScoreBps,
    );
  });

  it("discounts findings by confidence", () => {
    const at = (confidence: number) =>
      scoreWebResearch({
        ...cleanWeb,
        findings: [
          {
            subject: "buyer",
            category: "fraud",
            summary: "s",
            url: "https://e/1",
            publishedAt: null,
            confidence,
          },
        ],
      }).subScoreBps;
    expect(at(40)).toBeLessThan(at(90));
  });
});
