import { describeFailure, requestJson } from "../http.js";
import type { RequestOptions } from "../http.js";
import type { CacLookupConfig } from "../config.js";
import { ok, unavailable } from "../types.js";
import type {
  CacLookupResult,
  PartyRef,
  SourceResult,
  VerificationRequest,
} from "../types.js";

/**
 * Source 1 - CAC business registration lookup (Nigeria).
 *
 * The only source with a real per-call cost, which is why it runs last and why
 * the x402 fee is derived from it (NFR-5). It answers one question the other
 * three cannot: does this counterparty legally exist under the name on the
 * invoice.
 *
 * Three providers resell the same CAC data behind different response shapes.
 * Rather than pick one and hardcode its JSON, each provider gets an adapter
 * that maps its response onto `CacLookupResult`; adding a fourth is a new
 * adapter, not a change to the calling code.
 */

/** Which party the lookup is about. The buyer is who has to pay. */
export type CacSubject = "buyer" | "seller";

export interface CacLookupDeps {
  request?: <T>(url: string, options?: RequestOptions) => Promise<T>;
}

interface ProviderAdapter {
  /** Full request URL for a registration number. */
  url(baseUrl: string, rcNumber: string): string;
  headers(config: CacLookupConfig): Record<string, string>;
  /** Maps a provider response onto the common shape, or throws. */
  parse(body: unknown, rcNumber: string): Omit<CacLookupResult, "nameMismatch" | "provider">;
}

/** Reads a nested path, returning undefined rather than throwing. */
function pick(source: unknown, ...path: string[]): unknown {
  let current = source;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Normalises a provider's assorted date formats to an ISO 8601 date. */
function asIsoDate(value: unknown): string | null {
  const raw = asString(value);
  if (raw === null) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime())
    ? null
    : (parsed.toISOString().slice(0, 10) ?? null);
}

/**
 * A response that carries no company name at all is treated as "not found"
 * rather than "found with an unknown name" — the latter would let a lookup
 * that silently returned an empty envelope read as a successful check.
 */
function buildEntity(
  rcNumber: string,
  name: unknown,
  status: unknown,
  registrationDate: unknown,
): Omit<CacLookupResult, "nameMismatch" | "provider"> {
  const registeredName = asString(name);
  return {
    rcNumber,
    registered: registeredName !== null,
    registeredName,
    status: asString(status),
    registrationDate: asIsoDate(registrationDate),
  };
}

const ADAPTERS: Record<CacLookupConfig["CAC_LOOKUP_PROVIDER"], ProviderAdapter> = {
  dojah: {
    url: (base, rc) =>
      `${base}/api/v1/kyc/cac/advance?rc_number=${encodeURIComponent(rc)}`,
    headers: (config) => ({
      Authorization: config.CAC_LOOKUP_API_KEY,
      ...(config.CAC_LOOKUP_APP_ID === undefined
        ? {}
        : { AppId: config.CAC_LOOKUP_APP_ID }),
    }),
    parse: (body, rc) =>
      buildEntity(
        rc,
        pick(body, "entity", "company_name") ?? pick(body, "entity", "name"),
        pick(body, "entity", "company_status") ?? pick(body, "entity", "status"),
        pick(body, "entity", "date_of_registration") ??
          pick(body, "entity", "registration_date"),
      ),
  },
  mono: {
    url: (base, rc) => `${base}/v3/lookup/cac?search=${encodeURIComponent(rc)}`,
    headers: (config) => ({ "mono-sec-key": config.CAC_LOOKUP_API_KEY }),
    parse: (body, rc) =>
      buildEntity(
        rc,
        pick(body, "data", "name") ?? pick(body, "data", "company_name"),
        pick(body, "data", "status"),
        pick(body, "data", "date_of_registration"),
      ),
  },
  zeeh: {
    url: (base, rc) => `${base}/cac/company/${encodeURIComponent(rc)}`,
    headers: (config) => ({
      Authorization: `Bearer ${config.CAC_LOOKUP_API_KEY}`,
    }),
    parse: (body, rc) =>
      buildEntity(
        rc,
        pick(body, "data", "companyName") ?? pick(body, "data", "name"),
        pick(body, "data", "companyStatus") ?? pick(body, "data", "status"),
        pick(body, "data", "registrationDate"),
      ),
  },
};

/**
 * Compares the invoice's stated name against the registry's.
 *
 * Legal-form suffixes and punctuation vary constantly between how a company
 * writes its own name on an invoice and how CAC records it ("Zenith Foods
 * Ltd." vs "ZENITH FOODS LIMITED"), so those are normalised away before
 * comparing. What remains is the distinctive part of the name, and a
 * difference there is a real mismatch worth flagging.
 */
export function namesMatch(invoiceName: string, registeredName: string): boolean {
  const normalize = (name: string): string =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(
        /\b(limited|ltd|plc|nig|nigeria|incorporated|inc|company|co|enterprises|enterprise|ventures|and|the)\b/g,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim();

  return normalize(invoiceName) === normalize(registeredName);
}

export async function fetchCacLookup(
  request: VerificationRequest,
  config: CacLookupConfig,
  subject: CacSubject = "buyer",
  deps: CacLookupDeps = {},
): Promise<SourceResult<CacLookupResult>> {
  const party: PartyRef = request[subject];

  if (party.rcNumber === null || party.rcNumber.trim() === "") {
    // No RC number is a gap in the evidence, not a clean result. Reporting it
    // as unavailable routes it through the same penalty as a provider outage.
    return unavailable(
      `no CAC registration number was supplied for the ${subject} ("${party.name}"), so legal existence could not be checked`,
    );
  }

  const rcNumber = party.rcNumber.trim();
  const adapter = ADAPTERS[config.CAC_LOOKUP_PROVIDER];
  const send = deps.request ?? requestJson;

  try {
    const body = await send<unknown>(
      adapter.url(config.CAC_LOOKUP_BASE_URL.replace(/\/+$/, ""), rcNumber),
      {
        headers: adapter.headers(config),
        timeoutMs: 15_000,
        // This call costs money per attempt, so it retries once rather than
        // the default three times.
        attempts: 2,
      },
    );

    const entity = adapter.parse(body, rcNumber);

    return ok({
      ...entity,
      nameMismatch:
        entity.registeredName !== null &&
        !namesMatch(party.name, entity.registeredName),
      provider: config.CAC_LOOKUP_PROVIDER,
    });
  } catch (error) {
    return unavailable(
      `CAC lookup via ${config.CAC_LOOKUP_PROVIDER} failed for ${rcNumber}: ${describeFailure(error)}`,
    );
  }
}
