import { describe, expect, it } from "vitest";
import { fetchPlatformHistory } from "../src/sources/platformHistory.js";
import type { PlatformHistoryConfig } from "../src/config.js";
import type { VerificationRequest } from "../src/types.js";

const config: PlatformHistoryConfig = {
  TRUSTROVE_INDEXER_URL: "https://indexer.example/",
};

function invoice(overrides: Partial<VerificationRequest> = {}): VerificationRequest {
  return {
    invoiceId: `0x${"7f".repeat(32)}`,
    document: new Uint8Array([1, 2, 3]),
    documentFilename: "invoice.pdf",
    amountMinor: 500_000_00n,
    currency: "NGN",
    invoiceDate: "2026-01-05",
    dueDate: "2026-03-05",
    buyer: { address: "GBUYER", name: "Buyer Ltd", rcNumber: "RC111" },
    seller: { address: "GSELLER", name: "Seller Ltd", rcNumber: "RC222" },
    ...overrides,
  };
}

const cleanHistory = (address: string) => ({
  address,
  totalInvoices: 4,
  repaidInvoices: 4,
  defaultedInvoices: 0,
  lateInvoices: 0,
  averageDaysLate: 1.5,
});

function router(routes: Record<string, unknown>) {
  return async <T>(url: string): Promise<T> => {
    for (const [fragment, value] of Object.entries(routes)) {
      if (url.includes(fragment)) {
        if (value instanceof Error) throw value;
        return value as T;
      }
    }
    throw new Error(`unrouted url: ${url}`);
  };
}

describe("fetchPlatformHistory", () => {
  it("reports a clean history with no duplicate", async () => {
    const result = await fetchPlatformHistory(invoice(), config, {
      request: router({
        "by-document-hash": { invoiceIds: [] },
        GSELLER: cleanHistory("GSELLER"),
        GBUYER: cleanHistory("GBUYER"),
      }),
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.result.duplicateInvoice).toBe(false);
    expect(result.result.coldStart).toBe(false);
    expect(result.result.buyer.repaidInvoices).toBe(4);
  });

  it("flags a duplicate document hash but ignores the invoice's own id", async () => {
    const result = await fetchPlatformHistory(invoice(), config, {
      request: router({
        // The first entry is this invoice's own id, which is not a
        // duplicate of itself; the second is a genuine prior submission.
        "by-document-hash": {
          invoiceIds: [`0x${"7f".repeat(32)}`, `0x${"0e".repeat(32)}`],
        },
        GSELLER: cleanHistory("GSELLER"),
        GBUYER: cleanHistory("GBUYER"),
      }),
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.result.duplicateInvoice).toBe(true);
    expect(result.result.duplicateOfInvoiceIds).toEqual([`0x${"0e".repeat(32)}`]);
  });

  it("marks cold start when neither party has any record", async () => {
    const empty = (address: string) => ({ ...cleanHistory(address), totalInvoices: 0, repaidInvoices: 0, averageDaysLate: null });
    const result = await fetchPlatformHistory(invoice(), config, {
      request: router({
        "by-document-hash": { invoiceIds: [] },
        GSELLER: empty("GSELLER"),
        GBUYER: empty("GBUYER"),
      }),
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.result.coldStart).toBe(true);
  });

  it("degrades to unavailable when the indexer errors", async () => {
    const result = await fetchPlatformHistory(invoice(), config, {
      request: router({
        "by-document-hash": new Error("connection refused"),
        GSELLER: cleanHistory("GSELLER"),
        GBUYER: cleanHistory("GBUYER"),
      }),
    });

    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(result.reason).toContain("connection refused");
  });

  it("degrades to unavailable when the indexer returns an unexpected shape", async () => {
    const result = await fetchPlatformHistory(invoice(), config, {
      request: router({
        "by-document-hash": { invoiceIds: [] },
        GSELLER: { address: "GSELLER", totalInvoices: "many" },
        GBUYER: cleanHistory("GBUYER"),
      }),
    });

    expect(result.status).toBe("unavailable");
  });
});
