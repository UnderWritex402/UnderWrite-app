/**
 * Shared domain types for the Underwrite verification agent.
 *
 * Naming discipline (SRD NFR-4): the output of this service is a
 * "risk signal" / "verification score". It is never a credit score,
 * and no type, field, or comment here may call it one.
 */

/** Every data source reports its own availability. See SRD FR-6 / NFR-3. */
export type SourceStatus = "ok" | "unavailable";

/**
 * A source result is either `ok` with a payload, or `unavailable` with the
 * reason it failed. There is deliberately no third "partial" state: a source
 * that could not answer must not contribute confidence to the score.
 */
export type SourceResult<T> =
  | { status: "ok"; result: T }
  | { status: "unavailable"; reason: string };

export function ok<T>(result: T): SourceResult<T> {
  return { status: "ok", result };
}

export function unavailable<T>(reason: string): SourceResult<T> {
  return { status: "unavailable", reason };
}

/** Source 1 — CAC business registration lookup (Nigeria). */
export interface CacLookupResult {
  /** Registration number queried (RC/BN number). */
  rcNumber: string;
  /** Whether the registry returned a matching active entity. */
  registered: boolean;
  /** Registry-reported company name, for name-match checking. */
  registeredName: string | null;
  /** Registry-reported status string, e.g. "ACTIVE", "INACTIVE". */
  status: string | null;
  /** ISO 8601 date of incorporation, when the provider returns one. */
  registrationDate: string | null;
  /** True when the name on the invoice does not match the registry name. */
  nameMismatch: boolean;
  /** Which provider answered (dojah | mono | zeeh), for audit. */
  provider: string;
}

/** Source 2 — TrusTrove platform history. */
export interface PlatformHistoryResult {
  /** This exact invoice document hash has been submitted before. */
  duplicateInvoice: boolean;
  /** Prior invoice IDs sharing this document hash, if any. */
  duplicateOfInvoiceIds: string[];
  seller: CounterpartyHistory;
  buyer: CounterpartyHistory;
  /** True when neither party has any prior record — the cold-start case. */
  coldStart: boolean;
}

export interface CounterpartyHistory {
  /** Stellar address / platform identifier of the counterparty. */
  address: string;
  /** Invoices this party has been involved in, settled or otherwise. */
  totalInvoices: number;
  /** Invoices repaid in full. */
  repaidInvoices: number;
  /** Invoices that defaulted. */
  defaultedInvoices: number;
  /** Invoices currently past due but not yet written off. */
  lateInvoices: number;
  /** Mean days late across repaid invoices; null when there are none. */
  averageDaysLate: number | null;
}

/** Source 3 — web/news research for adverse signals. */
export interface WebResearchResult {
  queries: string[];
  findings: AdverseFinding[];
  /** Number of distinct sources consulted, for report transparency. */
  sourcesConsulted: number;
}

export type AdverseCategory =
  | "fraud"
  | "litigation"
  | "insolvency"
  | "regulatory"
  | "other";

export interface AdverseFinding {
  /** Which party the finding concerns. */
  subject: "buyer" | "seller";
  category: AdverseCategory;
  /** Short human-readable statement of the finding. */
  summary: string;
  url: string;
  /** Publication date if determinable, ISO 8601. */
  publishedAt: string | null;
  /** How strongly the agent believes the finding is about this party, 0-100. */
  confidence: number;
}

/** Source 4 — invoice document forensics. */
export interface DocumentForensicsResult {
  /** Detected file type, e.g. "pdf". */
  fileType: string;
  /** SHA-256 of the raw document bytes. */
  documentHash: string;
  signals: ForensicSignal[];
  metadata: DocumentMetadata;
}

export type ForensicSignalCode =
  | "producer_mismatch"
  | "modified_after_creation"
  | "incremental_update"
  | "multiple_producers"
  | "missing_metadata"
  | "annotation_overlay"
  | "creation_date_after_invoice_date"
  | "encrypted_document";

export interface ForensicSignal {
  code: ForensicSignalCode;
  /** What was observed, in plain language, for the evidence report. */
  detail: string;
  /** How suspicious this signal is on its own, 0-100. */
  severity: number;
}

export interface DocumentMetadata {
  producer: string | null;
  creator: string | null;
  creationDate: string | null;
  modificationDate: string | null;
  /** Number of `%%EOF` markers — >1 means the file was appended to. */
  eofMarkers: number;
  pdfVersion: string | null;
}

/** Input describing the invoice under verification. */
export interface VerificationRequest {
  invoiceId: string;
  /** Raw invoice document bytes, for forensics. */
  document: Uint8Array;
  /** Document filename, used only for type hinting. */
  documentFilename: string;
  /** Face value of the invoice in minor units (e.g. kobo). */
  amountMinor: bigint;
  currency: string;
  /** ISO 8601 date printed on the invoice. */
  invoiceDate: string;
  /** ISO 8601 date the invoice is due. */
  dueDate: string;
  buyer: PartyRef;
  seller: PartyRef;
}

export interface PartyRef {
  /** Platform address (Stellar) for on-chain history lookup. */
  address: string;
  /** Legal name as stated on the invoice. */
  name: string;
  /** CAC registration number, when the party supplied one. */
  rcNumber: string | null;
}

/**
 * The full off-chain evidence report. Only its hash goes on-chain
 * (SRD FR-9 / NFR-6).
 */
export interface EvidenceReport {
  invoiceId: string;
  agentId: string;
  sources: {
    cacLookup: SourceEnvelope<CacLookupResult>;
    platformHistory: SourceEnvelope<PlatformHistoryResult>;
    webResearch: SourceEnvelope<WebResearchResult>;
    documentForensics: SourceEnvelope<DocumentForensicsResult>;
  };
  /** Risk signal in basis points, 0-10000. Integer only. */
  riskScore: number;
  /** Per-source breakdown showing how riskScore was reached. */
  scoreBreakdown: ScoreBreakdown;
  /** keccak256 of the canonicalized report, with this field emptied. */
  evidenceHash: string;
  generatedAt: string;
}

/**
 * Envelope matching the SRD's `{ status, result? }` shape. `reason` is
 * carried alongside so an unavailable source explains itself in the report
 * rather than vanishing (FR-6).
 */
export type SourceEnvelope<T> =
  | { status: "ok"; result: T }
  | { status: "unavailable"; reason: string };

export interface ScoreBreakdown {
  /** Sum of the weights of sources that actually answered, in basis points. */
  answeredWeightBps: number;
  components: ScoreComponent[];
  /**
   * Penalty in basis points applied because one or more sources were
   * unavailable. Missing evidence raises the risk signal — it never
   * silently improves it (NFR-3).
   */
  unavailabilityPenaltyBps: number;
  notes: string[];
}

export interface ScoreComponent {
  source: keyof EvidenceReport["sources"];
  status: SourceStatus;
  /** This source's share of the total score, in basis points of 10000. */
  weightBps: number;
  /** This source's own risk sub-score, 0-10000. Null when unavailable. */
  subScoreBps: number | null;
  /** Human-readable reasons this sub-score is what it is. */
  reasons: string[];
}
