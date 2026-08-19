import {
  HttpMerchantPortalClient,
  merchantAuthLoginAction,
  merchantAuthRefreshAction,
  merchantOrdersGetAction,
} from "@goatnetwork/agentkit";
import { z } from "zod";
import { runAction } from "./goat/runtime.js";
import type { GoatRuntime } from "./goat/runtime.js";
import type { MerchantConfig } from "./config.js";
import type { ActionContext } from "./goat/types.js";

/**
 * x402 payment gating.
 *
 * Underwrite is the **merchant**, not the payer: TrusTrove pays for a report
 * and this service collects. So this module uses the merchant portal's
 * order/auth actions, and there is no payer wallet anywhere in it.
 *
 * FR-4 is the whole point of the file: no research begins until payment for
 * that report has actually settled. Research costs real money — the CAC
 * lookup is billed per call — so doing the work speculatively and hoping
 * payment arrives afterwards converts every abandoned listing into a direct
 * loss.
 *
 * ## Why webhooks are treated as untrusted
 *
 * The merchant portal can push `order.*` webhooks, and subscribing to them is
 * the right way to avoid polling. But a webhook is an unauthenticated HTTP
 * request from the internet until proven otherwise, and its *body* is never
 * treated as evidence here. A webhook only tells this service which order to
 * go and look at; the answer always comes from an authenticated
 * `orders.get` against the portal. That keeps the gate sound no matter what
 * signature scheme the webhooks use, and means a forged webhook achieves
 * nothing beyond causing one wasted API read.
 */

/** Documented x402 payment lifecycle. Only `settled` releases the work. */
export const PAYMENT_STATUSES = [
  "created",
  "authorized",
  "settled",
  "failed",
  "expired",
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** The only status that means money actually moved on-chain. */
export const SETTLED: PaymentStatus = "settled";

/**
 * Terminal statuses. An order in one of these will never become `settled`,
 * so a caller waiting on it should stop rather than keep polling.
 */
const TERMINAL_UNPAID: readonly PaymentStatus[] = ["failed", "expired"];

export class PaymentError extends Error {
  readonly orderId: string;
  readonly status: PaymentStatus | "unknown";
  /** True when the order can still reach `settled`. */
  readonly retryable: boolean;

  constructor(
    orderId: string,
    status: PaymentStatus | "unknown",
    retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "PaymentError";
    this.orderId = orderId;
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Parsed defensively: an order whose shape we do not recognise is treated as
 * unpaid rather than coerced into looking settled. Unknown extra fields are
 * allowed through, since the portal is free to add them.
 */
const orderSchema = z
  .object({
    id: z.string().optional(),
    order_id: z.string().optional(),
    status: z.string(),
    amount: z.union([z.string(), z.number()]).optional(),
    currency: z.string().optional(),
    /** Free-form field TrusTrove uses to say which invoice this pays for. */
    metadata: z.record(z.unknown()).optional(),
    reference: z.string().optional(),
  })
  .passthrough();

export interface PaymentRecord {
  orderId: string;
  status: PaymentStatus;
  amount: string | null;
  currency: string | null;
  /** The invoice this payment is for, when the order carries it. */
  invoiceId: string | null;
  /** The raw order, kept for the evidence trail. */
  raw: unknown;
}

/**
 * Holds the merchant portal session.
 *
 * The portal uses bearer tokens that expire, so the token is acquired lazily
 * and refreshed on demand rather than being read from configuration — a
 * long-lived token in an env file is exactly the credential you cannot rotate
 * when it leaks.
 */
export class MerchantSession {
  private readonly client: HttpMerchantPortalClient;
  private readonly runtime: GoatRuntime;
  private readonly config: MerchantConfig;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;

  constructor(
    runtime: GoatRuntime,
    config: MerchantConfig,
    client?: HttpMerchantPortalClient,
  ) {
    this.runtime = runtime;
    this.config = config;
    this.client =
      client ?? new HttpMerchantPortalClient(config.MERCHANT_PORTAL_BASE_URL);
  }

  /** The portal client, for actions this module does not wrap. */
  get portal(): HttpMerchantPortalClient {
    return this.client;
  }

  async token(): Promise<string> {
    if (this.accessToken !== null) return this.accessToken;
    return this.login();
  }

  private async login(): Promise<string> {
    const result = await runAction(
      this.runtime,
      merchantAuthLoginAction(this.client),
      {
        email: this.config.MERCHANT_PORTAL_EMAIL,
        password: this.config.MERCHANT_PORTAL_PASSWORD,
      },
    );
    return this.store(result);
  }

  /** Refreshes the access token, falling back to a full login. */
  async refresh(): Promise<string> {
    if (this.refreshToken === null) return this.login();
    try {
      const result = await runAction(
        this.runtime,
        merchantAuthRefreshAction(this.client),
        { refresh_token: this.refreshToken },
      );
      return this.store(result);
    } catch {
      // A refresh token can itself expire or be revoked; a full login is the
      // documented recovery, not an error to surface to the caller.
      this.refreshToken = null;
      return this.login();
    }
  }

  private store(result: unknown): string {
    const tokens = z
      .object({
        access_token: z.string().min(1),
        refresh_token: z.string().min(1).optional(),
      })
      .parse(result);

    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token ?? this.refreshToken;
    this.client.setAccessToken(tokens.access_token);
    return tokens.access_token;
  }

  /** Drops cached tokens. Used after a 401. */
  invalidate(): void {
    this.accessToken = null;
  }
}

function normalizeStatus(raw: string): PaymentStatus | "unknown" {
  const lowered = raw.toLowerCase();
  return (PAYMENT_STATUSES as readonly string[]).includes(lowered)
    ? (lowered as PaymentStatus)
    : "unknown";
}

function extractInvoiceId(order: z.infer<typeof orderSchema>): string | null {
  const fromMetadata = order.metadata?.["invoice_id"] ?? order.metadata?.["invoiceId"];
  if (typeof fromMetadata === "string" && fromMetadata !== "") {
    return fromMetadata;
  }
  return order.reference ?? null;
}

/** Reads one order from the portal, retrying once through a token refresh. */
export async function getOrder(
  session: MerchantSession,
  runtime: GoatRuntime,
  orderId: string,
): Promise<PaymentRecord> {
  const fetchOnce = async (accessToken: string): Promise<unknown> => {
    const action = merchantOrdersGetAction(session.portal);
    const context: ActionContext = {
      traceId: `underwrite-order-${orderId}`,
      network: runtime.network,
      now: Date.now(),
      accessToken,
    };
    const result = await runtime.runtime.run(
      action as never,
      context as never,
      { order_id: orderId } as never,
      { confirmed: true },
    );
    if (!result.ok || result.output === undefined) {
      throw new PaymentError(
        orderId,
        "unknown",
        true,
        `could not read order ${orderId} from the merchant portal: ${result.error ?? "no output"}`,
      );
    }
    return result.output;
  };

  let raw: unknown;
  try {
    raw = await fetchOnce(await session.token());
  } catch (error) {
    // One retry behind a fresh token: an expired bearer looks identical to a
    // genuine failure from here, and treating it as unpaid would stall a
    // report that was in fact paid for.
    session.invalidate();
    raw = await fetchOnce(await session.refresh()).catch(() => {
      throw error;
    });
  }

  const parsed = orderSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PaymentError(
      orderId,
      "unknown",
      true,
      `merchant portal returned an unrecognised order shape for ${orderId}; treating as unpaid`,
    );
  }

  const status = normalizeStatus(parsed.data.status);
  if (status === "unknown") {
    throw new PaymentError(
      orderId,
      "unknown",
      true,
      `merchant portal reported unrecognised status "${parsed.data.status}" for order ${orderId}; treating as unpaid`,
    );
  }

  return {
    orderId: parsed.data.id ?? parsed.data.order_id ?? orderId,
    status,
    amount: parsed.data.amount === undefined ? null : String(parsed.data.amount),
    currency: parsed.data.currency ?? null,
    invoiceId: extractInvoiceId(parsed.data),
    raw,
  };
}

/**
 * The gate. Returns the payment record only if the order has settled, and
 * throws otherwise — so a caller cannot proceed to research by ignoring a
 * return value.
 */
export async function requireSettledPayment(
  session: MerchantSession,
  runtime: GoatRuntime,
  orderId: string,
  options: { expectedInvoiceId?: string } = {},
): Promise<PaymentRecord> {
  const payment = await getOrder(session, runtime, orderId);

  if (payment.status !== SETTLED) {
    throw new PaymentError(
      orderId,
      payment.status,
      !TERMINAL_UNPAID.includes(payment.status),
      `order ${orderId} is "${payment.status}", not "${SETTLED}". Research does not start until payment settles on-chain.`,
    );
  }

  // A settled order for a *different* invoice is not payment for this one.
  // Without this check, one paid report could unlock verification of any
  // number of others.
  if (
    options.expectedInvoiceId !== undefined &&
    payment.invoiceId !== null &&
    payment.invoiceId !== options.expectedInvoiceId
  ) {
    throw new PaymentError(
      orderId,
      payment.status,
      false,
      `order ${orderId} settled for invoice ${payment.invoiceId}, not ${options.expectedInvoiceId}`,
    );
  }

  return payment;
}

/**
 * Handles an inbound webhook notification.
 *
 * The body is used only to learn which order changed. Whether that order is
 * actually paid is then re-read from the authenticated API, so nothing a
 * caller puts in the body can convince this service that an unpaid report
 * should proceed.
 */
export async function handlePaymentWebhook(
  session: MerchantSession,
  runtime: GoatRuntime,
  body: unknown,
): Promise<PaymentRecord | null> {
  const hint = z
    .object({
      data: z
        .object({ id: z.string().optional(), order_id: z.string().optional() })
        .passthrough()
        .optional(),
      order_id: z.string().optional(),
      id: z.string().optional(),
    })
    .passthrough()
    .safeParse(body);

  if (!hint.success) return null;

  const orderId =
    hint.data.order_id ??
    hint.data.id ??
    hint.data.data?.order_id ??
    hint.data.data?.id;

  if (orderId === undefined || orderId === "") return null;

  const payment = await getOrder(session, runtime, orderId);
  return payment.status === SETTLED ? payment : null;
}
