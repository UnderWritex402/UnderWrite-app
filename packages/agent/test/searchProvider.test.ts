import { describe, expect, it } from "vitest";
import { createSearchProvider } from "../src/sources/searchProvider.js";
import type { SearchConfig } from "../src/sources/searchProvider.js";

function config(provider: SearchConfig["WEB_SEARCH_PROVIDER"]): SearchConfig {
  return {
    WEB_SEARCH_PROVIDER: provider,
    WEB_SEARCH_API_KEY: "key",
    WEB_SEARCH_MAX_RESULTS: 5,
  };
}

describe("createSearchProvider", () => {
  it("normalises a Brave response", async () => {
    const provider = createSearchProvider(config("brave"), async (url) => {
      expect(String(url)).toContain("country=ng");
      return {
        web: {
          results: [
            {
              title: "T",
              url: "https://e/1",
              description: "D",
              page_age: "2025-11-02T00:00:00Z",
            },
          ],
        },
      } as never;
    });

    const hits = await provider.search("q");
    expect(hits).toEqual([
      {
        title: "T",
        url: "https://e/1",
        snippet: "D",
        publishedAt: "2025-11-02T00:00:00.000Z",
      },
    ]);
  });

  it("normalises a Tavily response to the same shape", async () => {
    const provider = createSearchProvider(config("tavily"), async () =>
      ({ results: [{ title: "T", url: "https://e/1", content: "D" }] }) as never,
    );

    const hits = await provider.search("q");
    expect(hits[0]).toEqual({
      title: "T",
      url: "https://e/1",
      snippet: "D",
      publishedAt: null,
    });
  });

  it("normalises a Serper response to the same shape", async () => {
    const provider = createSearchProvider(config("serper"), async () =>
      ({ organic: [{ title: "T", link: "https://e/1", snippet: "D" }] }) as never,
    );

    const hits = await provider.search("q");
    expect(hits[0]?.url).toBe("https://e/1");
  });

  it("returns no hits rather than throwing when a provider returns nothing", async () => {
    const provider = createSearchProvider(config("brave"), async () => ({}) as never);
    expect(await provider.search("q")).toEqual([]);
  });

  it("propagates provider errors so the source degrades transparently", async () => {
    const provider = createSearchProvider(config("brave"), async () => {
      throw new Error("429 rate limited");
    });
    await expect(provider.search("q")).rejects.toThrow("429 rate limited");
  });
});
