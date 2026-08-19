import {
  deriveNonce,
  hashEvidenceReport,
  signAttestation,
} from "./attestation.js";
import { scoreInvoice } from "./scoring.js";
import { analyzeDocument } from "./sources/documentForensics.js";
import { fetchCacLookup } from "./sources/cacLookup.js";
import { fetchPlatformHistory } from "./sources/platformHistory.js";
import { fetchWebResearch } from "./sources/webResearch.js";
import type { WebSearchProvider } from "./sources/webResearch.js";
import type { SignedAttestation } from "./attestation.js";
import type { EvidenceStore } from "./evidenceStore.js";
import type { SourceInputs } from "./scoring.js";
import type {
  CacLookupConfig,
  PlatformHistoryConfig,
} from "./config.js";
import type {
  EvidenceReport,
  SourceEnvelope,
  SourceResult,
  VerificationRequest,
} from "./types.js";

/**
 * The verification pipeline: four sources in, one signed attestation out.
 *
 * Ordering note — the sources run concurrently rather than in the build order
 * given in the spec. That order was about which to *implement* first (cheapest
 * and least dependent first); at runtime they are independent reads and there
 * is no reason to pay for them serially. The one real ordering constraint is
 * that payment settles before any of this is called, which is enforced by the
 * caller in `payment.ts` rather than here.
 */

export interface PipelineDeps {
  platformHistory: PlatformHistoryConfig;
  cacLookup: CacLookupConfig;
  searchProvider: WebSearchProvider;
  evidenceStore: EvidenceStore;
  /** Soroban Symbol the attestation is signed under. */
  agentId: string;
  /** secp256k1 key that signs attestation content. */
  privateKey: `0x${string}`;
  /** Injected for deterministic tests. */
  now?: () => Date;
}

export type VerificationOutcome =
  | {
      status: "attested";
      report: EvidenceReport;
      attestation: SignedAttestation;
    }
  | {
      status: "insufficient_evidence";
      /** Stored so a rejected verification is still auditable. */
      report: Omit<EvidenceReport, "riskScore"> & { riskScore: null };
      missing: string[];
      reason: string;
    };

/** Converts a source result into the report's envelope shape. */
function envelope<T>(result: SourceResult<T>): SourceEnvelope<T> {
  return result.status === "ok"
    ? { status: "ok", result: result.result }
    : { status: "unavailable", reason: result.reason };
}

/** Runs all four sources concurrently. None can reject: each degrades itself. */
export async function gatherEvidence(
  request: VerificationRequest,
  deps: PipelineDeps,
): Promise<SourceInputs> {
  const [platformHistory, cacLookup, webResearch] = await Promise.all([
    fetchPlatformHistory(request, deps.platformHistory),
    fetchCacLookup(request, deps.cacLookup, "buyer"),
    fetchWebResearch(request, deps.searchProvider),
  ]);

  // Synchronous and local, so it needs no await and cannot fail the batch.
  const documentForensics = analyzeDocument(request);

  return { platformHistory, cacLookup, webResearch, documentForensics };
}

export async function verifyInvoice(
  request: VerificationRequest,
  deps: PipelineDeps,
): Promise<VerificationOutcome> {
  const now = deps.now ?? ((): Date => new Date());
  const sources = await gatherEvidence(request, deps);
  const outcome = scoreInvoice(request, sources);

  const base = {
    invoiceId: request.invoiceId,
    agentId: deps.agentId,
    sources: {
      cacLookup: envelope(sources.cacLookup),
      platformHistory: envelope(sources.platformHistory),
      webResearch: envelope(sources.webResearch),
      documentForensics: envelope(sources.documentForensics),
    },
    scoreBreakdown: outcome.breakdown,
    generatedAt: now().toISOString(),
  };

  if (outcome.status === "insufficient_evidence") {
    // No score, no signature, no submission — but the report is still built
    // and stored, so a seller can be told *why* verification did not complete
    // and an operator can see which source was down (NFR-3, FR-6).
    const report = { ...base, riskScore: null, evidenceHash: "" };
    const evidenceHash = hashEvidenceReport(report as never);
    const stored = { ...report, evidenceHash };
    await deps.evidenceStore.put(stored as never);

    return {
      status: "insufficient_evidence",
      report: stored,
      missing: outcome.missing,
      reason: outcome.reason,
    };
  }

  // The hash covers the report with `evidenceHash` itself excluded, so the
  // field can carry the hash of the thing it is part of.
  const withScore = { ...base, riskScore: outcome.riskScore };
  const evidenceHash = hashEvidenceReport(withScore);
  const report: EvidenceReport = { ...withScore, evidenceHash };

  // Stored before signing: an attestation whose evidence cannot be retrieved
  // is an unverifiable number on a ledger, which is worse than no attestation.
  await deps.evidenceStore.put(report);

  const attestation = await signAttestation(
    {
      invoiceId: request.invoiceId,
      riskScore: outcome.riskScore,
      evidenceHash,
      agentId: deps.agentId,
      nonce: deriveNonce(deps.agentId, request.invoiceId, evidenceHash),
    },
    deps.privateKey,
  );

  return { status: "attested", report, attestation };
}
