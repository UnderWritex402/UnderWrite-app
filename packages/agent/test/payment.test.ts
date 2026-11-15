import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MerchantSession,
  PaymentError,
  getOrder,
  handlePaymentWebhook,
  requireSettledPayment,
  FilePaymentConsumptionStore,
  MemoryPaymentConsumptionStore,
  completePaymentConsumption,
} from "../src/payment.js";
import type { GoatRuntime } from "../src/goat/runtime.js";
import type { MerchantConfig } from "../src/config.js";

const config: MerchantConfig = {
  MERCHANT_PORTAL_BASE_URL: "https://portal.example",
  MERCHANT_PORTAL_EMAIL: "ops@underwrite.example",
  MERCHANT_PORTAL_PASSWORD: "hunter2",
};

interface Script {
  /** Order payloads returned by orders.get, in call order. */
  orders?: unknown[];
  /** Fail the first orders.get call, to exercise the token refresh path. */
  failFirstOrderRead?: boolean;
  onLogin?: () => void;
}

function stubRuntime(script: Script): {
  runtime: GoatRuntime;
  calls: { orderReads: number; logins: number };
} {
  const calls = { orderReads: 0, logins: 0 };
  const orders = [...(script.orders ?? [])];

  const run = async (action: { name: string }): Promise<unknown> => {
    const ok = (output: unknown): unknown => ({
      ok: true,
      output,
      traceId: "t",
      action: action.name,
      attempts: 1,
    });

    switch (action.name) {
      case "goat.x402.merchant.auth.login":
      case "goat.x402.merchant.auth.refresh":
        calls.logins += 1;
        script.onLogin?.();
        return ok({ access_token: `token-${calls.logins}`, refresh_token: "r" });

      case "goat.x402.merchant.orders.get": {
        calls.orderReads += 1;
        if (script.failFirstOrderRead === true && calls.orderReads === 1) {
          return {
            ok: false,
            error: "401 unauthorized",
            traceId: "t",
            action: action.name,
            attempts: 1,
          };
        }
        return ok(orders.shift() ?? { status: "created" });
      }

      default:
        throw new Error(`unexpected action ${action.name}`);
    }
  };

  return {
    runtime: {
      wallet: {} as never,
      runtime: { run } as never,
      network: "goat-testnet",
      address: "0x0000000000000000000000000000000000000001",
    },
    calls,
  };
}

function session(runtime: GoatRuntime): MerchantSession {
  return new MerchantSession(runtime, config);
}

describe("requireSettledPayment", () => {
  it("releases the work when the order has settled", async () => {
    const { runtime } = stubRuntime({
      orders: [
        {
          id: "ord_1",
          status: "settled",
          amount: "2500",
          currency: "USDC",
          metadata: { invoice_id: "inv-9" },
        },
      ],
    });

    const payment = await requireSettledPayment(
      session(runtime),
      runtime,
      "ord_1",
    );

    expect(payment.status).toBe("settled");
    expect(payment.invoiceId).toBe("inv-9");
    expect(payment.amount).toBe("2500");
  });

  it.each(["created", "authorized"] as const)(
    "refuses to start research while the order is %s, and marks it retryable",
    async (status) => {
      const { runtime } = stubRuntime({ orders: [{ status }] });

      const error = await requireSettledPayment(
        session(runtime),
        runtime,
        "ord_1",
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PaymentError);
      expect((error as PaymentError).status).toBe(status);
      expect((error as PaymentError).retryable).toBe(true);
    },
  );

  it.each(["failed", "expired"] as const)(
    "marks a %s order as not retryable",
    async (status) => {
      const { runtime } = stubRuntime({ orders: [{ status }] });

      const error = await requireSettledPayment(
        session(runtime),
        runtime,
        "ord_1",
      ).catch((e: unknown) => e);

      expect((error as PaymentError).retryable).toBe(false);
    },
  );

  it("rejects a settled order that paid for a different invoice", async () => {
    const { runtime } = stubRuntime({
      orders: [
        { status: "settled", metadata: { invoice_id: "inv-OTHER" } },
      ],
    });

    await expect(
      requireSettledPayment(session(runtime), runtime, "ord_1", {
        expectedInvoiceId: "inv-9",
      }),
    ).rejects.toThrow(/settled for invoice inv-OTHER/);
  });

  it("treats an unrecognised status as unpaid rather than assuming success", async () => {
    const { runtime } = stubRuntime({ orders: [{ status: "totally_new" }] });

    await expect(
      requireSettledPayment(session(runtime), runtime, "ord_1"),
    ).rejects.toThrow(/unrecognised status/);
  });

  it("treats an unrecognised order shape as unpaid", async () => {
    const { runtime } = stubRuntime({ orders: [{ nope: true }] });

    await expect(
      requireSettledPayment(session(runtime), runtime, "ord_1"),
    ).rejects.toThrow(/unrecognised order shape/);
  });
});

describe("MerchantSession", () => {
  it("logs in once and reuses the token", async () => {
    const { runtime, calls } = stubRuntime({
      orders: [{ status: "settled" }, { status: "settled" }],
    });
    const s = session(runtime);

    await getOrder(s, runtime, "ord_1");
    await getOrder(s, runtime, "ord_2");

    expect(calls.logins).toBe(1);
    expect(calls.orderReads).toBe(2);
  });

  it("re-authenticates once when the portal rejects the token", async () => {
    const { runtime, calls } = stubRuntime({
      failFirstOrderRead: true,
      orders: [{ status: "settled" }],
    });

    const payment = await getOrder(session(runtime), runtime, "ord_1");

    expect(payment.status).toBe("settled");
    expect(calls.logins).toBe(2);
    expect(calls.orderReads).toBe(2);
  });
});

describe("handlePaymentWebhook", () => {
  it("re-reads the order from the API rather than trusting the body", async () => {
    const { runtime, calls } = stubRuntime({ orders: [{ status: "settled" }] });

    const payment = await handlePaymentWebhook(session(runtime), runtime, {
      // The body claims settled, but that claim is never what is acted on.
      data: { id: "ord_1", status: "settled" },
    });

    expect(payment?.status).toBe("settled");
    expect(calls.orderReads).toBe(1);
  });

  it("returns null when the API says the order is not settled, whatever the body claims", async () => {
    const { runtime } = stubRuntime({ orders: [{ status: "created" }] });

    const payment = await handlePaymentWebhook(session(runtime), runtime, {
      order_id: "ord_1",
      status: "settled",
      amount: "999999",
    });

    expect(payment).toBeNull();
  });

  it("ignores a body with no order reference", async () => {
    const { runtime, calls } = stubRuntime({});
    const spy = vi.fn();

    expect(
      await handlePaymentWebhook(session(runtime), runtime, { hello: "world" }),
    ).toBeNull();
    expect(calls.orderReads).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("durable payment consumption (Issue #25)", () => {
  it("prevents one settled order from unlocking two different invoice verifications", async () => {
    const store = new MemoryPaymentConsumptionStore();
    const { runtime } = stubRuntime({
      orders: [
        { id: "ord_100", status: "settled", amount: "2500", currency: "USDC" },
        { id: "ord_100", status: "settled", amount: "2500", currency: "USDC" },
      ],
    });
    const s = session(runtime);

    await requireSettledPayment(s, runtime, "ord_100", {
      expectedInvoiceId: "inv-A",
      consumptionStore: store,
    });

    await expect(
      requireSettledPayment(s, runtime, "ord_100", {
        expectedInvoiceId: "inv-B",
        consumptionStore: store,
      }),
    ).rejects.toThrow(/already bound to invoice inv-A/);
  });

  it("rejects reuse after a report is completed, including after process restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "underwrite-payment-store-"));
    try {
      const store1 = new FilePaymentConsumptionStore(dir);
      const { runtime } = stubRuntime({
        orders: [
          {
            id: "ord_200",
            status: "settled",
            metadata: { invoice_id: "inv-200" },
          },
          {
            id: "ord_200",
            status: "settled",
            metadata: { invoice_id: "inv-200" },
          },
          {
            id: "ord_200",
            status: "settled",
            metadata: { invoice_id: "inv-999" },
          },
        ],
      });
      const s = session(runtime);

      await requireSettledPayment(s, runtime, "ord_200", {
        expectedInvoiceId: "inv-200",
        consumptionStore: store1,
      });

      const completed = await completePaymentConsumption(
        store1,
        "ord_200",
        "inv-200",
        { evidenceHash: "0xdeadbeef" },
      );
      expect(completed.state).toBe("completed");
      expect(completed.evidenceHash).toBe("0xdeadbeef");

      // Simulate restart with a fresh store reading from disk
      const storeAfterRestart = new FilePaymentConsumptionStore(dir);
      await expect(
        requireSettledPayment(s, runtime, "ord_200", {
          expectedInvoiceId: "inv-200",
          consumptionStore: storeAfterRestart,
        }),
      ).rejects.toThrow(/already been consumed by a completed verification/);

      await expect(
        requireSettledPayment(s, runtime, "ord_200", {
          expectedInvoiceId: "inv-999",
          consumptionStore: storeAfterRestart,
        }),
      ).rejects.toThrow(/already bound to invoice inv-200/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("distinguishes in-progress recovery after restart from concurrent duplicate workers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "underwrite-payment-recovery-"));
    try {
      const worker1Store = new FilePaymentConsumptionStore(dir);
      const { runtime } = stubRuntime({
        orders: [
          {
            id: "ord_300",
            status: "settled",
            metadata: { invoice_id: "inv-300" },
          },
          {
            id: "ord_300",
            status: "settled",
            metadata: { invoice_id: "inv-300" },
          },
          {
            id: "ord_300",
            status: "settled",
            metadata: { invoice_id: "inv-300" },
          },
        ],
      });
      const s = session(runtime);

      await requireSettledPayment(s, runtime, "ord_300", {
        expectedInvoiceId: "inv-300",
        consumptionStore: worker1Store,
      });

      const inProgress = await worker1Store.get("ord_300");
      expect(inProgress?.state).toBe("in_progress");

      // While worker1 still holds the in-flight claim, duplicate call on the same worker is rejected
      await expect(
        requireSettledPayment(s, runtime, "ord_300", {
          expectedInvoiceId: "inv-300",
          consumptionStore: worker1Store,
        }),
      ).rejects.toThrow(/already in progress/);

      // Simulate process crash and restart: new store instance recovers in-progress work for same invoice
      const restartedStore = new FilePaymentConsumptionStore(dir);
      const recovered = await requireSettledPayment(s, runtime, "ord_300", {
        expectedInvoiceId: "inv-300",
        consumptionStore: restartedStore,
      });
      expect(recovered.orderId).toBe("ord_300");

      await completePaymentConsumption(restartedStore, "ord_300", "inv-300");
      const finalRecord = await restartedStore.get("ord_300");
      expect(finalRecord?.state).toBe("completed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("allows only one concurrent worker to claim a settled order", async () => {
    const store = new MemoryPaymentConsumptionStore();
    const { runtime } = stubRuntime({
      orders: [
        { id: "ord_400", status: "settled", metadata: { invoice_id: "inv-400" } },
        { id: "ord_400", status: "settled", metadata: { invoice_id: "inv-400" } },
      ],
    });
    const s = session(runtime);

    const outcomes = await Promise.allSettled([
      requireSettledPayment(s, runtime, "ord_400", {
        expectedInvoiceId: "inv-400",
        consumptionStore: store,
      }),
      requireSettledPayment(s, runtime, "ord_400", {
        expectedInvoiceId: "inv-400",
        consumptionStore: store,
      }),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});
