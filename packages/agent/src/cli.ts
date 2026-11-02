import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  agentIdentityConfig,
  cacLookupConfig,
  evidenceStoreConfig,
  goatConfig,
  merchantConfig,
  platformHistoryConfig,
  submissionConfig,
} from "./config.js";
import { FileEvidenceStore } from "./evidenceStore.js";
import { createGoatRuntime } from "./goat/runtime.js";
import { MerchantSession, requireSettledPayment } from "./payment.js";
import { verifyInvoice } from "./pipeline.js";
import { createSearchProvider, searchConfig } from "./sources/searchProvider.js";
import { submitAttestation } from "./submit.js";
import type { VerificationRequest } from "./types.js";

const partySchema = z.object({
  address: z.string().min(1),
  name: z.string().min(1),
  rcNumber: z.string().min(1).nullable(),
});

const requestFileSchema = z.object({
  invoiceId: z
    .string()
    .regex(/^(?:0x)?[0-9a-fA-F]{64}$/, "must be a 32-byte hex invoice id"),
  documentPath: z.string().min(1),
  amountMinor: z.string().regex(/^\d+$/, "must be a non-negative integer string"),
  currency: z.string().min(1),
  invoiceDate: z.string().date(),
  dueDate: z.string().date(),
  buyer: partySchema,
  seller: partySchema,
});

export interface CliOptions {
  requestPath: string;
  orderId: string | null;
  skipPayment: boolean;
  submit: boolean;
}

function usage(): string {
  return [
    "Usage: underwrite-agent --request <request.json> (--order-id <id> | --skip-payment) [--submit]",
    "",
    "--order-id verifies that the merchant order settled before research starts.",
    "--skip-payment is for a controlled testnet operator run only.",
    "--submit sends a successful signed attestation to the configured Invoice contract.",
  ].join("\n");
}

export function parseCliArgs(args: string[]): CliOptions {
  let requestPath: string | null = null;
  let orderId: string | null = null;
  let skipPayment = false;
  let submit = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--request": {
        const value = args[index + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error(`--request requires a file path\n\n${usage()}`);
        }
        requestPath = value;
        index += 1;
        break;
      }
      case "--order-id": {
        const value = args[index + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error(`--order-id requires a value\n\n${usage()}`);
        }
        orderId = value;
        index += 1;
        break;
      }
      case "--skip-payment":
        skipPayment = true;
        break;
      case "--submit":
        submit = true;
        break;
      case "--help":
      case "-h":
        throw new Error(usage());
      default:
        throw new Error(`unknown argument: ${arg}\n\n${usage()}`);
    }
  }

  if (requestPath === null) {
    throw new Error(`--request is required\n\n${usage()}`);
  }
  if ((orderId === null) === !skipPayment) {
    throw new Error(
      `choose exactly one of --order-id or --skip-payment\n\n${usage()}`,
    );
  }

  return { requestPath, orderId, skipPayment, submit };
}

export async function loadVerificationRequest(
  requestPath: string,
): Promise<VerificationRequest> {
  const absoluteRequestPath = resolve(requestPath);
  const raw = JSON.parse(await readFile(absoluteRequestPath, "utf8")) as unknown;
  const input = requestFileSchema.parse(raw);
  const invoiceId = input.invoiceId.startsWith("0x")
    ? input.invoiceId
    : `0x${input.invoiceId}`;
  const documentPath = resolve(dirname(absoluteRequestPath), input.documentPath);

  return {
    invoiceId: invoiceId.toLowerCase() as `0x${string}`,
    document: await readFile(documentPath),
    documentFilename: documentPath.split("/").at(-1) ?? "invoice",
    amountMinor: BigInt(input.amountMinor),
    currency: input.currency,
    invoiceDate: input.invoiceDate,
    dueDate: input.dueDate,
    buyer: input.buyer,
    seller: input.seller,
  };
}

export async function runCli(args: string[]): Promise<number> {
  const options = parseCliArgs(args);
  const request = await loadVerificationRequest(options.requestPath);
  const identity = agentIdentityConfig();

  if (options.orderId !== null) {
    const runtime = createGoatRuntime(goatConfig(), identity, {
      writeEnabled: false,
    });
    const session = new MerchantSession(runtime, merchantConfig());
    await requireSettledPayment(session, runtime, options.orderId, {
      expectedInvoiceId: request.invoiceId,
    });
  } else {
    process.stderr.write(
      "underwrite-agent: payment check skipped for this controlled testnet run\n",
    );
  }

  const outcome = await verifyInvoice(request, {
    platformHistory: platformHistoryConfig(),
    cacLookup: cacLookupConfig(),
    searchProvider: createSearchProvider(searchConfig()),
    evidenceStore: new FileEvidenceStore(
      evidenceStoreConfig().EVIDENCE_STORE_DIR,
    ),
    agentId: identity.AGENT_ID,
    privateKey: identity.AGENT_EVM_PRIVATE_KEY as `0x${string}`,
  });

  if (outcome.status === "insufficient_evidence") {
    process.stdout.write(
      `${JSON.stringify({
        status: outcome.status,
        evidenceHash: outcome.report.evidenceHash,
        missing: outcome.missing,
        reason: outcome.reason,
      })}\n`,
    );
    return 2;
  }

  const result: Record<string, unknown> = {
    status: outcome.status,
    invoiceId: outcome.attestation.invoiceId,
    evidenceHash: outcome.report.evidenceHash,
    riskScore: outcome.report.riskScore,
  };

  if (options.submit) {
    const submitted = await submitAttestation(
      outcome.attestation,
      submissionConfig(),
    );
    result.transactionHash = submitted.transactionHash;
    result.ledger = submitted.ledger;
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const args = process.argv.slice(2);
  const execution = args.includes("--help") || args.includes("-h")
    ? Promise.resolve().then(() => {
        process.stdout.write(`${usage()}\n`);
        return 0;
      })
    : runCli(args);

  execution
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`underwrite-agent: ${message}\n`);
      process.exitCode = 1;
    });
}
