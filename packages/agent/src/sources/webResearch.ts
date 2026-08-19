import { describeFailure } from "../http.js";
import { ok, unavailable } from "../types.js";
import type {
  AdverseCategory,
  AdverseFinding,
  SourceResult,
  VerificationRequest,
  WebResearchResult,
} from "../types.js";

/**
 * Source 3 - adverse media / public record research.
 *
 * This module owns the *research method*: which questions get asked about a
 * counterparty, and how a raw search hit becomes a scored finding. It
 * deliberately does not own *how the web is searched*. The search backend is
 * injected as a `WebSearchProvider`, so binding it to a GOAT AgentKit search
 * plugin, or to any other provider, is a wiring decision made at the edge
 * rather than an API guess baked into the research logic.
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  /** ISO 8601 publication date when the provider supplies one. */
  publishedAt?: string | null;
}

export interface WebSearchProvider {
  /** Resolves to hits, or rejects. Rejections are never swallowed here. */
  search(query: string): Promise<SearchHit[]>;
  /** Provider name, recorded in the evidence report for auditability. */
  readonly name: string;
}

/**
 * Query suffixes appended to each party name. Kept explicit rather than
 * generated so the evidence report can state exactly what was asked, and so
 * changing the sweep is a reviewable diff.
 */
const ADVERSE_QUERY_TERMS = [
  "fraud",
  "lawsuit",
  "court judgment",
  "insolvency OR liquidation OR winding up",
  "EFCC investigation",
  "unpaid suppliers OR default",
];

/**
 * Keyword sets that classify a hit. Ordered most- to least-specific: the
 * first category whose keywords match wins, so "convicted of fraud" is
 * classified as fraud rather than as litigation.
 */
const CATEGORY_KEYWORDS: ReadonlyArray<{
  category: AdverseCategory;
  keywords: string[];
  /** Base confidence contributed by the category itself, 0-100. */
  weight: number;
}> = [
  {
    category: "fraud",
    keywords: [
      "fraud",
      "fraudulent",
      "scam",
      "embezzle",
      "forgery",
      "money laundering",
      "convicted",
      "efcc",
    ],
    weight: 55,
  },
  {
    category: "insolvency",
    keywords: [
      "insolven",
      "liquidation",
      "winding up",
      "receivership",
      "administration order",
      "bankrupt",
      "ceased trading",
    ],
    weight: 50,
  },
  {
    category: "regulatory",
    keywords: [
      "sanction",
      "regulatory action",
      "licence revoked",
      "license revoked",
      "banned",
      "blacklist",
      "penalty",
    ],
    weight: 45,
  },
  {
    category: "litigation",
    keywords: [
      "lawsuit",
      "sued",
      "court",
      "judgment",
      "judgement",
      "litigation",
      "tribunal",
      "claim filed",
    ],
    weight: 35,
  },
];

/**
 * Terms that indicate a hit is about a *resolved* or *dismissed* matter.
 * These reduce confidence rather than removing the finding: a dismissed suit
 * is still worth showing a human, just not worth scoring heavily.
 */
const MITIGATING_KEYWORDS = [
  "dismissed",
  "acquitted",
  "cleared of",
  "settled",
  "withdrawn",
  "overturned",
  "no case to answer",
];

export interface WebResearchOptions {
  /** Findings below this confidence are dropped as too weak to report. */
  minConfidence?: number;
}

export async function fetchWebResearch(
  request: VerificationRequest,
  provider: WebSearchProvider,
  options: WebResearchOptions = {},
): Promise<SourceResult<WebResearchResult>> {
  const { minConfidence = 35 } = options;

  const plan: Array<{ subject: "buyer" | "seller"; name: string; query: string }> =
    [];
  for (const subject of ["buyer", "seller"] as const) {
    const name = request[subject].name.trim();
    if (name === "") continue;
    for (const term of ADVERSE_QUERY_TERMS) {
      plan.push({ subject, name, query: `"${name}" ${term}` });
    }
  }

  if (plan.length === 0) {
    return unavailable(
      "neither party has a name to research, so no adverse-media sweep could be run",
    );
  }

  try {
    // A partially-completed sweep is not reported as a clean one. If any query
    // fails, the whole source is unavailable: a sweep that silently skipped
    // the seller would look identical to a seller with nothing against them,
    // which is exactly the false confidence NFR-3 forbids.
    const results = await Promise.all(
      plan.map(async (item) => ({
        ...item,
        hits: await provider.search(item.query),
      })),
    );

    const findings = new Map<string, AdverseFinding>();
    let sourcesConsulted = 0;

    for (const { subject, name, hits } of results) {
      sourcesConsulted += hits.length;
      for (const hit of hits) {
        const finding = classify(hit, subject, name);
        if (finding === null || finding.confidence < minConfidence) continue;

        // The same article surfaces across several queries. Keep the reading
        // with the highest confidence rather than counting it repeatedly.
        const key = `${subject}:${hit.url}`;
        const existing = findings.get(key);
        if (existing === undefined || finding.confidence > existing.confidence) {
          findings.set(key, finding);
        }
      }
    }

    return ok({
      queries: plan.map((item) => item.query),
      findings: [...findings.values()].sort(
        (a, b) => b.confidence - a.confidence,
      ),
      sourcesConsulted,
    });
  } catch (error) {
    return unavailable(
      `web research via ${provider.name} failed: ${describeFailure(error)}`,
    );
  }
}

/**
 * Turns one search hit into a finding, or null when the hit is not adverse or
 * is not credibly about this party.
 */
function classify(
  hit: SearchHit,
  subject: "buyer" | "seller",
  partyName: string,
): AdverseFinding | null {
  const haystack = `${hit.title} ${hit.snippet}`.toLowerCase();

  const matched = CATEGORY_KEYWORDS.find((entry) =>
    entry.keywords.some((keyword) => haystack.includes(keyword)),
  );
  if (matched === undefined) return null;

  // A hit that never names the party is almost always a same-sector article
  // caught by the adverse term alone. Requiring the name keeps the report
  // about this counterparty rather than about its industry.
  const nameScore = scoreNameMatch(haystack, partyName);
  if (nameScore === 0) return null;

  const mitigated = MITIGATING_KEYWORDS.some((keyword) =>
    haystack.includes(keyword),
  );

  const confidence = clamp(
    Math.round(matched.weight * nameScore) + (mitigated ? -20 : 0),
    0,
    100,
  );

  return {
    subject,
    category: matched.category,
    summary: mitigated ? `${hit.title} (appears resolved)` : hit.title,
    url: hit.url,
    publishedAt: hit.publishedAt ?? null,
    confidence,
  };
}

/**
 * How strongly the text refers to this party: 1.0 for the full name, a
 * partial credit for all distinctive words present, 0 for neither.
 */
function scoreNameMatch(haystack: string, partyName: string): number {
  const normalized = partyName.toLowerCase().trim();
  if (normalized !== "" && haystack.includes(normalized)) return 1;

  // Legal-form words are shared by thousands of companies and carry no
  // identifying power, so they do not count toward a match.
  const stopWords = new Set([
    "limited",
    "ltd",
    "plc",
    "nigeria",
    "nig",
    "enterprises",
    "enterprise",
    "ventures",
    "company",
    "co",
    "and",
    "the",
    "&",
  ]);
  const distinctive = normalized
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !stopWords.has(word));

  if (distinctive.length === 0) return 0;
  const present = distinctive.filter((word) => haystack.includes(word));
  if (present.length !== distinctive.length) return 0;

  return 0.7;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
