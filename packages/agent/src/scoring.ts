import type {
  CacLookupResult,
  DocumentForensicsResult,
  EvidenceReport,
  PlatformHistoryResult,
  ScoreBreakdown,
  ScoreComponent,
  SourceResult,
  VerificationRequest,
  WebResearchResult,
} from "./types.js";

/**
 * Combines the four sources into a single risk signal in basis points.
 *
 * Two rules govern everything in this file:
 *
 * 1. **All integer arithmetic.** Every value is in basis points (0-10000) and
 *    every division is floored explicitly. Nothing here produces a float that
 *    could disagree with the u32 the Soroban contract stores.
 *
 * 2. **Missing evidence never improves the signal.** A source that could not
 *    answer is excluded from the weighted average and then charged a penalty.
 *    If too much of the evidence base is missing, this module refuses to emit
 *    a number at all rather than emitting a confident-looking one (NFR-3).
 *
 * Higher is worse: 0 is the cleanest possible signal, 10000 the worst.
 * This is a risk signal, not a credit score (NFR-4).
 */

export const BPS = 10_000;

/** Source weights, in basis points of the total. Must sum to BPS. */
export const SOURCE_WEIGHTS_BPS = {
  platformHistory: 3_500,
  cacLookup: 2_500,
  documentForensics: 2_500,
  webResearch: 1_500,
} as const satisfies Record<keyof EvidenceReport["sources"], number>;

export type SourceKey = keyof typeof SOURCE_WEIGHTS_BPS;

/**
 * Sources whose absence makes a verification meaningless rather than merely
 * incomplete.
 *
 * - `platformHistory` and `documentForensics` cost nothing and have no paid
 *   third-party dependency, so their failure means *our* pipeline is broken,
 *   not that the world is unavailable.
 * - `cacLookup` is the only proof that the counterparty legally exists. An
 *   invoice cleared without it has not actually been verified, however clean
 *   everything else looks.
 *
 * `webResearch` is deliberately not required: adverse media is corroborating
 * evidence, and its absence is priced through the unavailability penalty
 * instead of blocking the report.
 *
 * Making CAC required means a provider outage stops verification, and so
 * stops financing. That is the intended trade: it is a business decision to
 * relax it, made by editing this list, not something to be quietly worked
 * around at the call site.
 */
export const REQUIRED_SOURCES: readonly SourceKey[] = [
  "platformHistory",
  "documentForensics",
  "cacLookup",
];

/**
 * Charged against the final signal for each basis point of source weight that
 * went unanswered. At 3000, losing web research entirely (1500 weight) adds
 * 450 bps of risk: enough to matter, not enough to fail an otherwise clean
 * invoice on its own.
 */
export const UNAVAILABILITY_PENALTY_RATE_BPS = 3_000;

export interface SourceInputs {
  platformHistory: SourceResult<PlatformHistoryResult>;
  cacLookup: SourceResult<CacLookupResult>;
  documentForensics: SourceResult<DocumentForensicsResult>;
  webResearch: SourceResult<WebResearchResult>;
}

export type ScoringOutcome =
  | { status: "scored"; riskScore: number; breakdown: ScoreBreakdown }
  | {
      status: "insufficient_evidence";
      /** Which required sources were missing. */
      missing: SourceKey[];
      reason: string;
      breakdown: ScoreBreakdown;
    };

/** Integer-safe `value * numerator / denominator`, floored. */
function scale(value: number, numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.floor((value * numerator) / denominator);
}

function clampBps(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 0), BPS);
}

export function scoreInvoice(
  request: VerificationRequest,
  sources: SourceInputs,
): ScoringOutcome {
  const components: ScoreComponent[] = [
    buildComponent("platformHistory", sources.platformHistory, (r) =>
      scorePlatformHistory(r),
    ),
    buildComponent("cacLookup", sources.cacLookup, (r) =>
      scoreCacLookup(r, request),
    ),
    buildComponent("documentForensics", sources.documentForensics, (r) =>
      scoreDocumentForensics(r),
    ),
    buildComponent("webResearch", sources.webResearch, (r) =>
      scoreWebResearch(r),
    ),
  ];

  const answeredWeightBps = components
    .filter((c) => c.status === "ok")
    .reduce((sum, c) => sum + c.weightBps, 0);
  const missingWeightBps = BPS - answeredWeightBps;
  const unavailabilityPenaltyBps = scale(
    missingWeightBps,
    UNAVAILABILITY_PENALTY_RATE_BPS,
    BPS,
  );

  const notes: string[] = [];
  for (const component of components) {
    if (component.status === "unavailable") {
      notes.push(
        `${component.source} was unavailable; its ${component.weightBps} bps of weight was excluded and penalised.`,
      );
    }
  }

  const breakdown: ScoreBreakdown = {
    answeredWeightBps,
    components,
    unavailabilityPenaltyBps,
    notes,
  };

  const missing = REQUIRED_SOURCES.filter(
    (key) => sources[key].status !== "ok",
  );
  if (missing.length > 0) {
    return {
      status: "insufficient_evidence",
      missing,
      reason: `required source(s) unavailable: ${missing.join(", ")}. No risk signal was produced.`,
      breakdown,
    };
  }

  // Weighted average across answered sources only, then the penalty on top.
  const weighted = components.reduce(
    (sum, c) =>
      c.subScoreBps === null ? sum : sum + c.subScoreBps * c.weightBps,
    0,
  );
  const average = Math.floor(weighted / answeredWeightBps);
  const riskScore = clampBps(average + unavailabilityPenaltyBps);

  notes.push(
    `Weighted average over ${answeredWeightBps} bps of answered sources: ${average} bps; plus ${unavailabilityPenaltyBps} bps unavailability penalty.`,
  );

  return { status: "scored", riskScore, breakdown };
}

function buildComponent<T>(
  source: SourceKey,
  result: SourceResult<T>,
  score: (result: T) => { subScoreBps: number; reasons: string[] },
): ScoreComponent {
  const weightBps = SOURCE_WEIGHTS_BPS[source];
  if (result.status !== "ok") {
    return {
      source,
      status: "unavailable",
      weightBps,
      subScoreBps: null,
      reasons: [result.reason],
    };
  }
  const { subScoreBps, reasons } = score(result.result);
  return {
    source,
    status: "ok",
    weightBps,
    subScoreBps: clampBps(subScoreBps),
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Per-source sub-scores. Each returns 0-10000 plus the reasons behind it.
// ---------------------------------------------------------------------------

/**
 * Platform history. The strongest single signal available, because it is
 * about these exact counterparties rather than about the world in general.
 */
export function scorePlatformHistory(result: PlatformHistoryResult): {
  subScoreBps: number;
  reasons: string[];
} {
  const reasons: string[] = [];

  if (result.duplicateInvoice) {
    // Double-financing the same document is the single most direct fraud in
    // invoice finance. Nothing else in a clean history offsets it.
    return {
      subScoreBps: BPS,
      reasons: [
        `This invoice document has already been submitted to the platform as ${result.duplicateOfInvoiceIds.join(", ")}. Double-financing the same receivable is the primary fraud this check exists to catch.`,
      ],
    };
  }

  if (result.coldStart) {
    reasons.push(
      "Neither party has any prior platform record, so this source has no counterparty-specific signal. Scored as unproven, not as clean.",
    );
    return { subScoreBps: 5_000, reasons };
  }

  let score = 2_000;
  reasons.push("Baseline for a counterparty with an existing platform record.");

  // The buyer is who actually has to pay, so their record dominates.
  const buyer = result.buyer;
  if (buyer.totalInvoices > 0) {
    const defaultRateBps = scale(buyer.defaultedInvoices, BPS, buyer.totalInvoices);
    const contribution = scale(defaultRateBps, 4_000, BPS);
    if (contribution > 0) {
      score += contribution;
      reasons.push(
        `Buyer has defaulted on ${buyer.defaultedInvoices} of ${buyer.totalInvoices} prior invoices (+${contribution} bps).`,
      );
    }

    const lateRateBps = scale(buyer.lateInvoices, BPS, buyer.totalInvoices);
    const lateContribution = scale(lateRateBps, 1_500, BPS);
    if (lateContribution > 0) {
      score += lateContribution;
      reasons.push(
        `Buyer is currently late on ${buyer.lateInvoices} of ${buyer.totalInvoices} invoices (+${lateContribution} bps).`,
      );
    }

    // Chronic lateness short of default still ties up an investor's capital.
    if (buyer.averageDaysLate !== null && buyer.averageDaysLate > 7) {
      const daysContribution = Math.min(
        scale(Math.trunc(buyer.averageDaysLate), 1_000, 60),
        1_000,
      );
      score += daysContribution;
      reasons.push(
        `Buyer repays on average ${Math.trunc(buyer.averageDaysLate)} days late (+${daysContribution} bps).`,
      );
    }
  } else {
    score += 1_500;
    reasons.push(
      "Buyer has no prior platform record, so their repayment behaviour is unproven (+1500 bps).",
    );
  }

  const seller = result.seller;
  if (seller.totalInvoices > 0) {
    const sellerDefaultBps = scale(
      seller.defaultedInvoices,
      BPS,
      seller.totalInvoices,
    );
    const contribution = scale(sellerDefaultBps, 2_500, BPS);
    if (contribution > 0) {
      score += contribution;
      reasons.push(
        `Seller has been party to ${seller.defaultedInvoices} defaulted invoices of ${seller.totalInvoices} (+${contribution} bps).`,
      );
    }
  } else {
    score += 1_000;
    reasons.push("Seller has no prior platform record (+1000 bps).");
  }

  // A substantial clean record is real evidence and is allowed to reduce risk.
  if (buyer.repaidInvoices >= 5 && buyer.defaultedInvoices === 0) {
    score -= 1_000;
    reasons.push(
      `Buyer has repaid ${buyer.repaidInvoices} invoices with no defaults (-1000 bps).`,
    );
  }

  return { subScoreBps: score, reasons };
}

/** CAC registration. Binary at the top end: an unregistered buyer is fatal. */
export function scoreCacLookup(
  result: CacLookupResult,
  request: VerificationRequest,
): { subScoreBps: number; reasons: string[] } {
  if (!result.registered) {
    return {
      subScoreBps: 9_500,
      reasons: [
        `CAC has no active registration for ${result.rcNumber}. The counterparty may not legally exist as stated on the invoice.`,
      ],
    };
  }

  let score = 500;
  const reasons = [
    `CAC confirms registration ${result.rcNumber} via ${result.provider}.`,
  ];

  if (result.nameMismatch) {
    score += 3_000;
    reasons.push(
      `The name on the invoice does not match the registered name${result.registeredName === null ? "" : ` ("${result.registeredName}")`} (+3000 bps).`,
    );
  }

  const status = result.status?.toUpperCase() ?? null;
  if (status !== null && status !== "ACTIVE") {
    score += 2_500;
    reasons.push(`Registry reports status "${result.status}" (+2500 bps).`);
  }

  // A company incorporated weeks before issuing a large invoice is the classic
  // shell-company shape. It is not proof of anything, but it is worth pricing.
  if (result.registrationDate !== null) {
    const registered = Date.parse(result.registrationDate);
    const invoiced = Date.parse(request.invoiceDate);
    if (!Number.isNaN(registered) && !Number.isNaN(invoiced)) {
      const ageDays = Math.floor((invoiced - registered) / 86_400_000);
      if (ageDays >= 0 && ageDays < 180) {
        score += 1_500;
        reasons.push(
          `Counterparty was registered only ${ageDays} days before the invoice date (+1500 bps).`,
        );
      }
    }
  }

  return { subScoreBps: score, reasons };
}

/**
 * Document forensics. The worst single signal dominates, with the remainder
 * contributing at a discount, so five weak signals cannot outweigh one strong
 * one and one strong one is not diluted by the absence of others.
 */
export function scoreDocumentForensics(result: DocumentForensicsResult): {
  subScoreBps: number;
  reasons: string[];
} {
  if (result.signals.length === 0) {
    return {
      subScoreBps: 500,
      reasons: [
        "No structural tamper signals found. Absence of evidence of editing is not proof the document is genuine, so this is a low signal rather than zero.",
      ],
    };
  }

  const sorted = [...result.signals].sort((a, b) => b.severity - a.severity);
  const worst = sorted[0];
  if (worst === undefined) {
    return { subScoreBps: 500, reasons: [] };
  }

  const dominant = scale(worst.severity, 7_000, 100);
  const remainderSeverity = Math.min(
    sorted.slice(1).reduce((sum, s) => sum + s.severity, 0),
    100,
  );
  const secondary = scale(remainderSeverity, 3_000, 100);

  const reasons = sorted.map((s) => `[${s.code}] ${s.detail}`);
  reasons.push(
    `Strongest signal contributes ${dominant} bps; ${sorted.length - 1} further signal(s) contribute ${secondary} bps.`,
  );

  return { subScoreBps: dominant + secondary, reasons };
}

/** How much each adverse category is worth at full confidence, in bps. */
const CATEGORY_SEVERITY_BPS = {
  fraud: 10_000,
  insolvency: 9_000,
  regulatory: 7_000,
  litigation: 5_000,
  other: 3_000,
} as const;

/** Adverse media. Same dominant-plus-discounted-remainder shape as forensics. */
export function scoreWebResearch(result: WebResearchResult): {
  subScoreBps: number;
  reasons: string[];
} {
  if (result.findings.length === 0) {
    return {
      subScoreBps: 1_000,
      reasons: [
        `No adverse findings across ${result.queries.length} queries and ${result.sourcesConsulted} results. Nigerian company news coverage is thin, so a clean sweep is weak evidence and is scored as such.`,
      ],
    };
  }

  const contributions = result.findings
    .map((finding) => ({
      finding,
      // Confidence discounts severity: a probable match to a fraud conviction
      // should not score the same as a certain one.
      bps: scale(
        CATEGORY_SEVERITY_BPS[finding.category],
        finding.confidence,
        100,
      ),
    }))
    .sort((a, b) => b.bps - a.bps);

  const worst = contributions[0];
  if (worst === undefined) return { subScoreBps: 1_000, reasons: [] };

  const secondary = Math.min(
    contributions.slice(1).reduce((sum, c) => sum + scale(c.bps, 30, 100), 0),
    2_000,
  );

  const reasons = contributions.map(
    ({ finding, bps }) =>
      `${finding.subject} / ${finding.category} (confidence ${finding.confidence}, ${bps} bps): ${finding.summary} — ${finding.url}`,
  );

  return { subScoreBps: worst.bps + secondary, reasons };
}
