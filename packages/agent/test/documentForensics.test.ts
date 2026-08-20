import { describe, expect, it } from "vitest";
import {
  analyzeDocument,
  parsePdfDate,
} from "../src/sources/documentForensics.js";
import type {
  DocumentForensicsResult,
  ForensicSignalCode,
  SourceResult,
  VerificationRequest,
} from "../src/types.js";

/** Builds a minimal but structurally real PDF byte string. */
function pdf(options: {
  info?: string;
  body?: string;
  eofs?: number;
  version?: string;
  /** An incremental revision appended after the original %%EOF. */
  appended?: string;
}): Uint8Array {
  const {
    info = "/Producer (Acme Accounting 4.1) /CreationDate (D:20260105093000Z)",
    body = "1 0 obj << /Type /Catalog >> endobj",
    eofs = 1,
    version = "1.7",
    appended,
  } = options;
  const head = `%PDF-${version}\n${body}\ntrailer << /Info << ${info} >> >>\n`;
  const original = head + "%%EOF\n".repeat(eofs);
  return new TextEncoder().encode(
    appended === undefined ? original : `${original}${appended}\n%%EOF\n`,
  );
}

function request(
  document: Uint8Array,
  invoiceDate = "2026-01-05",
): VerificationRequest {
  return {
    invoiceId: `0x${"7f".repeat(32)}`,
    document,
    documentFilename: "invoice.pdf",
    amountMinor: 500_000_00n,
    currency: "NGN",
    invoiceDate,
    dueDate: "2026-03-05",
    buyer: { address: "GBUYER", name: "Buyer Ltd", rcNumber: "RC111" },
    seller: { address: "GSELLER", name: "Seller Ltd", rcNumber: "RC222" },
  };
}

function codes(result: SourceResult<DocumentForensicsResult>): ForensicSignalCode[] {
  if (result.status !== "ok") throw new Error(`expected ok, got: ${result.reason}`);
  return result.result.signals.map((s) => s.code);
}

describe("parsePdfDate", () => {
  it("parses a UTC pdf date", () => {
    expect(parsePdfDate("D:20260105093000Z")).toBe("2026-01-05T09:30:00.000Z");
  });

  it("applies a positive timezone offset", () => {
    expect(parsePdfDate("D:20260105093000+01'00'")).toBe(
      "2026-01-05T08:30:00.000Z",
    );
  });

  it("returns null for an unparseable value", () => {
    expect(parsePdfDate("yesterday")).toBeNull();
    expect(parsePdfDate(undefined)).toBeNull();
  });
});

describe("analyzeDocument", () => {
  it("reports no signals for a clean single-pass PDF", () => {
    const result = analyzeDocument(request(pdf({})));
    expect(codes(result)).toEqual([]);
    if (result.status !== "ok") return;
    expect(result.result.fileType).toBe("pdf");
    expect(result.result.metadata.producer).toBe("Acme Accounting 4.1");
    expect(result.result.metadata.pdfVersion).toBe("1.7");
  });

  it("flags incremental updates from repeated EOF markers", () => {
    const result = analyzeDocument(request(pdf({ eofs: 3 })));
    expect(codes(result)).toContain("incremental_update");
  });

  it("flags a document rewritten by a different producer in a later revision", () => {
    const document = pdf({
      info: "/Producer (Acme Accounting 4.1) /CreationDate (D:20260105093000Z)",
      appended: "trailer << /Info << /Producer (Adobe Photoshop 25.0) >> >>",
    });
    const result = analyzeDocument(request(document));
    expect(codes(result)).toContain("multiple_producers");
    expect(codes(result)).toContain("incremental_update");
    // Last writer wins: the file as it stands was written by the editing tool.
    expect(codes(result)).toContain("producer_mismatch");
  });

  it("flags modification after creation", () => {
    const document = pdf({
      info:
        "/Producer (Acme Accounting 4.1) /CreationDate (D:20260105093000Z) /ModDate (D:20260107140000Z)",
    });
    const result = analyzeDocument(request(document));
    expect(codes(result)).toContain("modified_after_creation");
  });

  it("flags a PDF created well after the invoice date it states", () => {
    const document = pdf({
      info: "/Producer (Acme Accounting 4.1) /CreationDate (D:20260220093000Z)",
    });
    const result = analyzeDocument(request(document, "2026-01-05"));
    expect(codes(result)).toContain("creation_date_after_invoice_date");
  });

  it("flags overlay annotations", () => {
    const document = pdf({
      body: "1 0 obj << /Subtype /FreeText /Contents (250,000) >> endobj",
    });
    expect(codes(analyzeDocument(request(document)))).toContain(
      "annotation_overlay",
    );
  });

  it("flags a document with no producer or creator", () => {
    const document = pdf({ info: "/Title (Invoice)" });
    expect(codes(analyzeDocument(request(document)))).toContain(
      "missing_metadata",
    );
  });

  it("identifies a non-PDF upload without claiming PDF checks ran", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const result = analyzeDocument(request(png));
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.result.fileType).toBe("png");
    expect(result.result.metadata.producer).toBeNull();
    expect(codes(result)).toEqual(["missing_metadata"]);
  });

  it("degrades to unavailable for an empty document", () => {
    const result = analyzeDocument(request(new Uint8Array()));
    expect(result.status).toBe("unavailable");
  });

  it("hashes the document bytes deterministically", () => {
    const doc = pdf({});
    const a = analyzeDocument(request(doc));
    const b = analyzeDocument(request(doc));
    if (a.status !== "ok" || b.status !== "ok") throw new Error("expected ok");
    expect(a.result.documentHash).toBe(b.result.documentHash);
    expect(a.result.documentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
