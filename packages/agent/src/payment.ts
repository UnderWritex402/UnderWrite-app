import {
  HttpMerchantPortalClient,
  merchantAuthLoginAction,
  merchantAuthRefreshAction,
  merchantOrdersGetAction,
} from "@goatnetwork/agentkit";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  options: RequireSettledPaymentOptions = {},
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

  if (options.consumptionStore !== undefined) {
    const invoiceId = options.expectedInvoiceId ?? payment.invoiceId;
    if (invoiceId === null || invoiceId === undefined || invoiceId === "") {
      throw new PaymentError(
        orderId,
        payment.status,
        false,
        `order ${orderId} cannot be consumed without an invoice ID`,
      );
    }
    await options.consumptionStore.claim(payment.orderId, invoiceId, {
      resumeInProgress: options.resumeInProgress,
      now: options.now,
    });
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

export type PaymentConsumptionState = "in_progress" | "completed";

export interface PaymentConsumptionRecord {
  orderId: string;
  invoiceId: string;
  state: PaymentConsumptionState;
  startedAt: string;
  completedAt: string | null;
  evidenceHash: string | null;
}

export interface ClaimConsumptionOptions {
  /** Allow recovering an interrupted in-progress claim for the same invoice after restart. */
  resumeInProgress?: boolean | undefined;
  now?: (() => Date) | undefined;
}

export interface CompleteConsumptionOptions {
  evidenceHash?: string | null | undefined;
  now?: (() => Date) | undefined;
}

export interface PaymentConsumptionStore {
  get(orderId: string): Promise<PaymentConsumptionRecord | null>;
  claim(
    orderId: string,
    invoiceId: string,
    options?: ClaimConsumptionOptions,
  ): Promise<PaymentConsumptionRecord>;
  complete(
    orderId: string,
    invoiceId: string,
    options?: CompleteConsumptionOptions,
  ): Promise<PaymentConsumptionRecord>;
}

export interface RequireSettledPaymentOptions {
  expectedInvoiceId?: string | undefined;
  consumptionStore?: PaymentConsumptionStore | undefined;
  resumeInProgress?: boolean | undefined;
  now?: (() => Date) | undefined;
}

const consumptionRecordSchema = z.object({
  orderId: z.string().min(1),
  invoiceId: z.string().min(1),
  state: z.enum(["in_progress", "completed"]),
  startedAt: z.string().min(1),
  completedAt: z.string().nullable(),
  evidenceHash: z.string().nullable(),
});

function sanitizeOrderKey(orderId: string): string {
  const trimmed = orderId.trim();
  if (trimmed === "" || !/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    throw new PaymentError(
      orderId,
      "unknown",
      false,
      `invalid order ID "${orderId}" for consumption record storage`,
    );
  }
  return trimmed;
}

function validateClaimTransition(
  existing: PaymentConsumptionRecord,
  orderId: string,
  invoiceId: string,
  isInFlightInWorker: boolean,
  resumeInProgress: boolean,
): PaymentConsumptionRecord {
  if (existing.invoiceId !== invoiceId) {
    throw new PaymentError(
      orderId,
      SETTLED,
      false,
      `order ${orderId} is already bound to invoice ${existing.invoiceId} and cannot unlock invoice ${invoiceId}`,
    );
  }

  if (existing.state === "completed") {
    throw new PaymentError(
      orderId,
      SETTLED,
      false,
      `order ${orderId} has already been consumed by a completed verification for invoice ${existing.invoiceId}`,
    );
  }

  if (isInFlightInWorker || !resumeInProgress) {
    throw new PaymentError(
      orderId,
      SETTLED,
      false,
      `order ${orderId} verification for invoice ${existing.invoiceId} is already in progress`,
    );
  }

  return existing;
}

/**
 * In-memory idempotency store for unit tests and single-process runs.
 */
export class MemoryPaymentConsumptionStore implements PaymentConsumptionStore {
  private readonly records = new Map<string, PaymentConsumptionRecord>();
  private readonly inFlight = new Set<string>();

  constructor(initial: Iterable<PaymentConsumptionRecord> = []) {
    for (const record of initial) {
      this.records.set(record.orderId, { ...record });
    }
  }

  async get(orderId: string): Promise<PaymentConsumptionRecord | null> {
    const key = sanitizeOrderKey(orderId);
    const existing = this.records.get(key);
    return existing === undefined ? null : { ...existing };
  }

  async claim(
    orderId: string,
    invoiceId: string,
    options: ClaimConsumptionOptions = {},
  ): Promise<PaymentConsumptionRecord> {
    const key = sanitizeOrderKey(orderId);
    const existing = this.records.get(key);

    if (existing !== undefined) {
      const recovered = validateClaimTransition(
        existing,
        key,
        invoiceId,
        this.inFlight.has(key),
        options.resumeInProgress ?? false,
      );
      this.inFlight.add(key);
      return { ...recovered };
    }

    const now = options.now ?? (() => new Date());
    const created: PaymentConsumptionRecord = {
      orderId: key,
      invoiceId,
      state: "in_progress",
      startedAt: now().toISOString(),
      completedAt: null,
      evidenceHash: null,
    };
    this.records.set(key, created);
    this.inFlight.add(key);
    return { ...created };
  }

  async complete(
    orderId: string,
    invoiceId: string,
    options: CompleteConsumptionOptions = {},
  ): Promise<PaymentConsumptionRecord> {
    const key = sanitizeOrderKey(orderId);
    const existing = this.records.get(key);
    if (existing === undefined) {
      throw new PaymentError(
        key,
        SETTLED,
        false,
        `cannot complete order ${key}: no in-progress payment consumption record exists`,
      );
    }
    if (existing.invoiceId !== invoiceId) {
      throw new PaymentError(
        key,
        SETTLED,
        false,
        `cannot complete order ${key} for invoice ${invoiceId}: bound to invoice ${existing.invoiceId}`,
      );
    }
    if (existing.state === "completed") {
      this.inFlight.delete(key);
      return { ...existing };
    }

    const now = options.now ?? (() => new Date());
    const updated: PaymentConsumptionRecord = {
      ...existing,
      state: "completed",
      completedAt: now().toISOString(),
      evidenceHash: options.evidenceHash ?? null,
    };
    this.records.set(key, updated);
    this.inFlight.delete(key);
    return { ...updated };
  }

  /** Simulates a worker crash in tests by dropping the in-memory lock while preserving persisted records. */
  simulateRestart(): MemoryPaymentConsumptionStore {
    return new MemoryPaymentConsumptionStore(this.records.values());
  }
}

/**
 * Durable filesystem-backed idempotency store.
 *
 * Uses an exclusive `.lock` file during claim/complete transitions and atomic
 * temp-file renames so neither process crashes nor concurrent workers can
 * unlock two verifications with the same settled order.
 */
export class FilePaymentConsumptionStore implements PaymentConsumptionStore {
  private readonly directory: string;
  private readonly inFlight = new Set<string>();

  constructor(directory: string) {
    this.directory = directory;
  }

  private recordPath(orderId: string): string {
    return join(this.directory, `${sanitizeOrderKey(orderId)}.json`);
  }

  private lockPath(orderId: string): string {
    return join(this.directory, `${sanitizeOrderKey(orderId)}.lock`);
  }

  private async withOrderLock<T>(orderId: string, fn: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const lockFile = this.lockPath(orderId);
    let handle;
    try {
      handle = await open(lockFile, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new PaymentError(
          orderId,
          SETTLED,
          false,
          `order ${orderId} is currently locked by a concurrent verification worker`,
        );
      }
      throw error;
    }

    try {
      return await fn();
    } finally {
      await handle.close().catch(() => undefined);
      await rm(lockFile, { force: true }).catch(() => undefined);
    }
  }

  private async readUnlocked(orderId: string): Promise<PaymentConsumptionRecord | null> {
    try {
      const raw = await readFile(this.recordPath(orderId), "utf8");
      return consumptionRecordSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw new PaymentError(
        orderId,
        "unknown",
        false,
        `corrupt payment consumption record for order ${orderId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async writeUnlocked(record: PaymentConsumptionRecord): Promise<void> {
    const target = this.recordPath(record.orderId);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(temp, target);
  }

  async get(orderId: string): Promise<PaymentConsumptionRecord | null> {
    return this.readUnlocked(sanitizeOrderKey(orderId));
  }

  async claim(
    orderId: string,
    invoiceId: string,
    options: ClaimConsumptionOptions = {},
  ): Promise<PaymentConsumptionRecord> {
    const key = sanitizeOrderKey(orderId);
    return this.withOrderLock(key, async () => {
      const existing = await this.readUnlocked(key);
      if (existing !== null) {
        const recovered = validateClaimTransition(
          existing,
          key,
          invoiceId,
          this.inFlight.has(key),
          options.resumeInProgress ?? true,
        );
        this.inFlight.add(key);
        return recovered;
      }

      const now = options.now ?? (() => new Date());
      const created: PaymentConsumptionRecord = {
        orderId: key,
        invoiceId,
        state: "in_progress",
        startedAt: now().toISOString(),
        completedAt: null,
        evidenceHash: null,
      };
      await this.writeUnlocked(created);
      this.inFlight.add(key);
      return created;
    });
  }

  async complete(
    orderId: string,
    invoiceId: string,
    options: CompleteConsumptionOptions = {},
  ): Promise<PaymentConsumptionRecord> {
    const key = sanitizeOrderKey(orderId);
    return this.withOrderLock(key, async () => {
      const existing = await this.readUnlocked(key);
      if (existing === null) {
        throw new PaymentError(
          key,
          SETTLED,
          false,
          `cannot complete order ${key}: no in-progress payment consumption record exists`,
        );
      }
      if (existing.invoiceId !== invoiceId) {
        throw new PaymentError(
          key,
          SETTLED,
          false,
          `cannot complete order ${key} for invoice ${invoiceId}: bound to invoice ${existing.invoiceId}`,
        );
      }
      if (existing.state === "completed") {
        this.inFlight.delete(key);
        return existing;
      }

      const now = options.now ?? (() => new Date());
      const updated: PaymentConsumptionRecord = {
        ...existing,
        state: "completed",
        completedAt: now().toISOString(),
        evidenceHash: options.evidenceHash ?? null,
      };
      await this.writeUnlocked(updated);
      this.inFlight.delete(key);
      return updated;
    });
  }

}

export async function completePaymentConsumption(
  store: PaymentConsumptionStore,
  orderId: string,
  invoiceId: string,
  options: CompleteConsumptionOptions = {},
): Promise<PaymentConsumptionRecord> {
  return store.complete(orderId, invoiceId, options);
}
