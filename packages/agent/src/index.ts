/**
 * Public surface of the Underwrite verification agent.
 *
 * The output of this service is a **risk signal**, never a credit score
 * (NFR-4). That distinction is legal as much as linguistic: Underwrite is not
 * a licensed credit bureau, and nothing here should be described as though it
 * were.
 */

export * from "./types.js";
export * from "./config.js";
export {
  HttpError,
  describeFailure,
  requestJson,
  type RequestOptions,
} from "./http.js";

// Data sources
export {
  documentHashHex,
  fetchPlatformHistory,
} from "./sources/platformHistory.js";
export { analyzeDocument, parsePdfDate } from "./sources/documentForensics.js";
export {
  fetchWebResearch,
  type SearchHit,
  type WebResearchOptions,
  type WebSearchProvider,
} from "./sources/webResearch.js";
export {
  SEARCH_PROVIDERS,
  createSearchProvider,
  searchConfig,
  type SearchConfig,
  type SearchProviderName,
} from "./sources/searchProvider.js";
export {
  fetchCacLookup,
  namesMatch,
  type CacSubject,
} from "./sources/cacLookup.js";

// Scoring
export {
  BPS,
  REQUIRED_SOURCES,
  SOURCE_WEIGHTS_BPS,
  UNAVAILABILITY_PENALTY_RATE_BPS,
  scoreCacLookup,
  scoreDocumentForensics,
  scoreInvoice,
  scorePlatformHistory,
  scoreWebResearch,
  type ScoringOutcome,
  type SourceInputs,
  type SourceKey,
} from "./scoring.js";

// Attestation
export {
  AttestationError,
  DOMAIN_SEPARATOR,
  buildAttestationPayload,
  canonicalize,
  deriveNonce,
  hashEvidenceReport,
  signAttestation,
  type AttestationFields,
  type SignedAttestation,
} from "./attestation.js";

// Evidence storage
export {
  EvidenceStoreError,
  FileEvidenceStore,
  MemoryEvidenceStore,
  type EvidenceStore,
} from "./evidenceStore.js";

// Pipeline
export {
  gatherEvidence,
  verifyInvoice,
  type PipelineDeps,
  type VerificationOutcome,
} from "./pipeline.js";

// Soroban submission
export {
  AlreadyAttestedError,
  SubmissionError,
  buildServer,
  submitAttestation,
  type SorobanServer,
  type SubmissionPhase,
  type SubmissionResult,
  type SubmitDeps,
} from "./submit.js";

// GOAT: identity and payment
export {
  actionContext,
  createGoatRuntime,
  runAction,
  GoatRuntimeError,
  type CreateRuntimeOptions,
  type GoatRuntime,
} from "./goat/runtime.js";
export {
  IdentityError,
  buildRegistrationDocument,
  ensureRegistered,
  getReputation,
  registryIdentifier,
  setRegistrationUri,
  type AgentIdentity,
  type ReputationSummary,
} from "./identity.js";
export {
  MerchantSession,
  PAYMENT_STATUSES,
  PaymentError,
  SETTLED,
  getOrder,
  handlePaymentWebhook,
  requireSettledPayment,
  type PaymentRecord,
  type PaymentStatus,
} from "./payment.js";
