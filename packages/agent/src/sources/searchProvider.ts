import { z } from "zod";
import { requestJson } from "../http.js";
import type { RequestOptions } from "../http.js";
import type { SearchHit, WebSearchProvider } from "./webResearch.js";

/**
 * Concrete web search backends for source 3.
 *
 * AgentKit ships fifteen plugins and none of them does web or news search, so
 * this is a plain HTTP integration rather than an AgentKit action. Three
 * providers are supported behind one interface for the same reason the CAC
 * module has three adapters: the research logic should not have to change when
 * the vendor does, and a rate-limited provider should be swappable by
 * configuration rather than by a code change.
 */

export const SEARCH_PROVIDERS = ["brave", "tavily", "serper"] as const;
export type SearchProviderName = (typeof SEARCH_PROVIDERS)[number];

const searchConfigSchema = z.object({
  WEB_SEARCH_PROVIDER: z.enum(SEARCH_PROVIDERS),
  WEB_SEARCH_API_KEY: z.string().min(1),
  /** Results requested per query. Higher costs more and adds little. */
  WEB_SEARCH_MAX_RESULTS: z.coerce.number().int().min(1).max(20).default(10),
});

export type SearchConfig = z.infer<typeof searchConfigSchema>;

export function searchConfig(env: NodeJS.ProcessEnv = process.env): SearchConfig {
  const parsed = searchConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Invalid configuration for web search: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

type Send = <T>(url: string, options?: RequestOptions) => Promise<T>;

/** Coerces a provider's date field to ISO 8601, or null if unusable. */
function toIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const braveSchema = z.object({
  web: z
    .object({
      results: z
        .array(
          z.object({
            title: z.string(),
            url: z.string(),
            description: z.string().optional(),
            age: z.string().optional(),
            page_age: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

const tavilySchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string(),
        url: z.string(),
        content: z.string().optional(),
        published_date: z.string().optional(),
      }),
    )
    .optional(),
});

const serperSchema = z.object({
  organic: z
    .array(
      z.object({
        title: z.string(),
        link: z.string(),
        snippet: z.string().optional(),
        date: z.string().optional(),
      }),
    )
    .optional(),
});

function braveProvider(config: SearchConfig, send: Send): WebSearchProvider {
  return {
    name: "brave",
    async search(query: string): Promise<SearchHit[]> {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(config.WEB_SEARCH_MAX_RESULTS));
      // Nigeria-focused: source 3 is scoped to Nigerian counterparties in v1.
      url.searchParams.set("country", "ng");

      const body = await send<unknown>(url.toString(), {
        headers: {
          "X-Subscription-Token": config.WEB_SEARCH_API_KEY,
          accept: "application/json",
        },
        timeoutMs: 12_000,
      });

      return (braveSchema.parse(body).web?.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.description ?? "",
        publishedAt: toIsoDate(r.page_age ?? r.age),
      }));
    },
  };
}

function tavilyProvider(config: SearchConfig, send: Send): WebSearchProvider {
  return {
    name: "tavily",
    async search(query: string): Promise<SearchHit[]> {
      const body = await send<unknown>("https://api.tavily.com/search", {
        method: "POST",
        headers: { authorization: `Bearer ${config.WEB_SEARCH_API_KEY}` },
        body: {
          query,
          max_results: config.WEB_SEARCH_MAX_RESULTS,
          search_depth: "basic",
        },
        timeoutMs: 20_000,
      });

      return (tavilySchema.parse(body).results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content ?? "",
        publishedAt: toIsoDate(r.published_date),
      }));
    },
  };
}

function serperProvider(config: SearchConfig, send: Send): WebSearchProvider {
  return {
    name: "serper",
    async search(query: string): Promise<SearchHit[]> {
      const body = await send<unknown>("https://google.serper.dev/search", {
        method: "POST",
        headers: { "X-API-KEY": config.WEB_SEARCH_API_KEY },
        body: { q: query, gl: "ng", num: config.WEB_SEARCH_MAX_RESULTS },
        timeoutMs: 12_000,
      });

      return (serperSchema.parse(body).organic ?? []).map((r) => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet ?? "",
        publishedAt: toIsoDate(r.date),
      }));
    },
  };
}

export function createSearchProvider(
  config: SearchConfig,
  send: Send = requestJson,
): WebSearchProvider {
  switch (config.WEB_SEARCH_PROVIDER) {
    case "brave":
      return braveProvider(config, send);
    case "tavily":
      return tavilyProvider(config, send);
    case "serper":
      return serperProvider(config, send);
  }
}
