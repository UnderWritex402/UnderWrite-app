import { createHash } from "node:crypto";
import { z } from "zod";
import { describeFailure, requestJson } from "../http.js";
import type { RequestOptions } from "../http.js";
import type { PlatformHistoryConfig } from "../config.js";
import { ok, unavailable } from "../types.js";
import type {
  CounterpartyHistory,
  PlatformHistoryResult,
  SourceResult,
  VerificationRequest,
} from "../types.js";

/**
 * Source 2 — TrusTrove's own platform history.
 *
 * Free, no third-party dependency, and it compounds in value as the platform
 * accumulates invoices — which is why it is built and queried first. Its known
 * weakness is the cold-start case: a brand-new buyer/seller pair produces no
 * signal at all. That case is reported explicitly as `coldStart` rather than
 * being allowed to look like a clean record (PRD §10).
 */

/**
 * The indexer's responses are validated rather than trusted. If the indexer
 * changes shape, this source reports itself unavailable — which raises the
 * risk signal — instead of silently coercing garbage into a clean history.
 */
const counterpartyHistorySchema = z.object({
  address: z.string().min(1),
  totalInvoices: z.number().int().nonnegative(),
  repaidInvoices: z.number().int().nonnegative(),
  defaultedInvoices: z.number().int().nonnegative(),
  lateInvoices: z.number().int().nonnegative(),
  averageDaysLate: z.number().nullable(),
});

const duplicateCheckSchema = z.object({
  /** Invoice ids already recorded against this exact document hash. */
  invoiceIds: z.array(z.string()),
});

export interface PlatformHistoryDeps {
  /** Injected for tests; defaults to the shared JSON client. */
  request?: <T>(url: string, options?: RequestOptions) => Promise<T>;
}

function authHeaders(config: PlatformHistoryConfig): Record<string, string> {
  return config.TRUSTROVE_INDEXER_API_KEY === undefined
    ? {}
    : { authorization: `Bearer ${config.TRUSTROVE_INDEXER_API_KEY}` };
}

/** SHA-256 of the invoice document, used as the duplicate-detection key. */
export function documentHashHex(document: Uint8Array): string {
  return createHash("sha256").update(document).digest("hex");
}

export async function fetchPlatformHistory(
  request: VerificationRequest,
  config: PlatformHistoryConfig,
  deps: PlatformHistoryDeps = {},
): Promise<SourceResult<PlatformHistoryResult>> {
  const send = deps.request ?? requestJson;
  const base = config.TRUSTROVE_INDEXER_URL.replace(/\/+$/, "");
  const headers = authHeaders(config);

  try {
    const docHash = documentHashHex(request.document);

    // All three reads are independent, so they go out together. Any one
    // rejecting fails the whole source — a partial history is not a history.
    const [duplicatesRaw, sellerRaw, buyerRaw] = await Promise.all([
      send<unknown>(
        `${base}/invoices/by-document-hash/${docHash}`,
        { headers, timeoutMs: 8_000 },
      ),
      send<unknown>(
        `${base}/parties/${encodeURIComponent(request.seller.address)}/history`,
        { headers, timeoutMs: 8_000 },
      ),
      send<unknown>(
        `${base}/parties/${encodeURIComponent(request.buyer.address)}/history`,
        { headers, timeoutMs: 8_000 },
      ),
    ]);

    const duplicates = duplicateCheckSchema.parse(duplicatesRaw);
    const seller = counterpartyHistorySchema.parse(sellerRaw);
    const buyer = counterpartyHistorySchema.parse(buyerRaw);

    // The invoice under verification may already be indexed against its own
    // id; that is not a duplicate of itself.
    const priorIds = duplicates.invoiceIds.filter(
      (id) => id !== request.invoiceId,
    );

    return ok({
      duplicateInvoice: priorIds.length > 0,
      duplicateOfInvoiceIds: priorIds,
      seller: normalizeHistory(seller),
      buyer: normalizeHistory(buyer),
      coldStart: seller.totalInvoices === 0 && buyer.totalInvoices === 0,
    });
  } catch (error) {
    return unavailable(
      `TrusTrove indexer unavailable: ${describeFailure(error)}`,
    );
  }
}

/**
 * Clamps counts that the indexer could in principle report inconsistently
 * (more repaid than total, say) so downstream scoring never divides by a
 * nonsensical denominator.
 */
function normalizeHistory(
  raw: z.infer<typeof counterpartyHistorySchema>,
): CounterpartyHistory {
  const total = Math.max(
    raw.totalInvoices,
    raw.repaidInvoices + raw.defaultedInvoices,
  );
  return {
    address: raw.address,
    totalInvoices: total,
    repaidInvoices: raw.repaidInvoices,
    defaultedInvoices: raw.defaultedInvoices,
    lateInvoices: raw.lateInvoices,
    averageDaysLate: raw.averageDaysLate,
  };
}
