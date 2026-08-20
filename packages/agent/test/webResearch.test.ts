import { describe, expect, it } from "vitest";
import { fetchWebResearch } from "../src/sources/webResearch.js";
import type {
  SearchHit,
  WebSearchProvider,
} from "../src/sources/webResearch.js";
import type { VerificationRequest } from "../src/types.js";

function request(
  buyerName = "Zenith Foods Limited",
  sellerName = "Kanem Logistics Limited",
): VerificationRequest {
  return {
    invoiceId: `0x${"7f".repeat(32)}`,
    document: new Uint8Array([1]),
    documentFilename: "invoice.pdf",
    amountMinor: 500_000_00n,
    currency: "NGN",
    invoiceDate: "2026-01-05",
    dueDate: "2026-03-05",
    buyer: { address: "GBUYER", name: buyerName, rcNumber: "RC111" },
    seller: { address: "GSELLER", name: sellerName, rcNumber: "RC222" },
  };
}

function providerReturning(
  hitsFor: (query: string) => SearchHit[],
): WebSearchProvider {
  return { name: "stub", search: async (query) => hitsFor(query) };
}

const emptyProvider = providerReturning(() => []);

describe("fetchWebResearch", () => {
  it("returns no findings when nothing adverse surfaces", async () => {
    const result = await fetchWebResearch(request(), emptyProvider);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.result.findings).toEqual([]);
    expect(result.result.queries.length).toBeGreaterThan(0);
  });

  it("classifies a fraud article about the buyer", async () => {
    const provider = providerReturning((query) =>
      query.includes("Zenith Foods")
        ? [
            {
              title: "Zenith Foods Limited directors convicted of fraud",
              url: "https://news.example/a",
              snippet: "The EFCC secured a conviction against Zenith Foods Limited.",
              publishedAt: "2025-11-02",
            },
          ]
        : [],
    );

    const result = await fetchWebResearch(request(), provider);
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.result.findings).toHaveLength(1);
    expect(result.result.findings[0]?.category).toBe("fraud");
    expect(result.result.findings[0]?.subject).toBe("buyer");
    expect(result.result.findings[0]?.confidence).toBeGreaterThanOrEqual(50);
  });

  it("deduplicates the same article seen across several queries", async () => {
    const hit: SearchHit = {
      title: "Kanem Logistics Limited sued over unpaid invoices",
      url: "https://news.example/b",
      snippet: "A claim was filed in Lagos against Kanem Logistics Limited.",
    };
    const provider = providerReturning((query) =>
      query.includes("Kanem Logistics") ? [hit] : [],
    );

    const result = await fetchWebResearch(request(), provider);
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.result.findings).toHaveLength(1);
    expect(result.result.findings[0]?.category).toBe("litigation");
  });

  it("ignores adverse articles that never name the party", async () => {
    const provider = providerReturning(() => [
      {
        title: "Nigerian logistics sector hit by fraud wave",
        url: "https://news.example/c",
        snippet: "Several unnamed firms are under investigation.",
      },
    ]);

    const result = await fetchWebResearch(request(), provider);
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.result.findings).toEqual([]);
  });

  it("discounts a matter that was dismissed", async () => {
    const base = (snippet: string) =>
      providerReturning((query) =>
        query.includes("Zenith Foods")
          ? [
              {
                title: "Zenith Foods Limited fraud case",
                url: "https://news.example/d",
                snippet,
              },
            ]
          : [],
      );

    const live = await fetchWebResearch(request(), base("case proceeding"));
    const resolved = await fetchWebResearch(
      request(),
      base("the case was dismissed by the court"),
    );
    if (live.status !== "ok" || resolved.status !== "ok") {
      throw new Error("expected ok");
    }

    const liveConfidence = live.result.findings[0]?.confidence ?? 0;
    const resolvedConfidence = resolved.result.findings[0]?.confidence ?? 0;
    expect(resolvedConfidence).toBeLessThan(liveConfidence);
    expect(resolved.result.findings[0]?.summary).toContain("appears resolved");
  });

  it("degrades to unavailable rather than reporting a partial sweep", async () => {
    let calls = 0;
    const flaky: WebSearchProvider = {
      name: "flaky",
      search: async () => {
        calls += 1;
        if (calls === 3) throw new Error("rate limited");
        return [];
      },
    };

    const result = await fetchWebResearch(request(), flaky);
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(result.reason).toContain("rate limited");
    expect(result.reason).toContain("flaky");
  });

  it("is unavailable when neither party has a name to search", async () => {
    const result = await fetchWebResearch(request("", ""), emptyProvider);
    expect(result.status).toBe("unavailable");
  });
});
