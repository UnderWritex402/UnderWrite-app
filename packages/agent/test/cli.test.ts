import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadVerificationRequest, parseCliArgs } from "../src/cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("parseCliArgs", () => {
  it("requires a request and exactly one payment mode", () => {
    expect(() => parseCliArgs(["--request", "invoice.json"])).toThrow(
      /exactly one/,
    );
    expect(() =>
      parseCliArgs([
        "--request",
        "invoice.json",
        "--order-id",
        "ord_1",
        "--skip-payment",
      ]),
    ).toThrow(/exactly one/);
  });

  it("parses an explicit testnet submission run", () => {
    expect(
      parseCliArgs([
        "--request",
        "invoice.json",
        "--skip-payment",
        "--submit",
      ]),
    ).toEqual({
      requestPath: "invoice.json",
      orderId: null,
      skipPayment: true,
      submit: true,
    });
  });
});

describe("loadVerificationRequest", () => {
  it("loads document bytes and normalizes the invoice id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "underwrite-cli-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "invoice.pdf"), "%PDF-1.7\n%%EOF\n");
    await writeFile(
      join(directory, "request.json"),
      JSON.stringify({
        invoiceId: "ab".repeat(32),
        documentPath: "invoice.pdf",
        amountMinor: "5000000000",
        currency: "NGN",
        invoiceDate: "2026-11-02",
        dueDate: "2026-12-02",
        buyer: {
          address: "GBUYER",
          name: "Demo Buyer",
          rcNumber: "RC100",
        },
        seller: {
          address: "GSELLER",
          name: "Demo Seller",
          rcNumber: "RC200",
        },
      }),
    );

    const request = await loadVerificationRequest(
      join(directory, "request.json"),
    );

    expect(request.invoiceId).toBe(`0x${"ab".repeat(32)}`);
    expect(request.amountMinor).toBe(5_000_000_000n);
    expect(new TextDecoder().decode(request.document)).toContain("%PDF-1.7");
  });
});
