# CLI / Service Reference

The repository contains a TypeScript library, an automation-friendly operator CLI, and **Xwrite**, the interactive operator TUI. The hosted HTTP surface is a status and discovery endpoint; it does not accept invoice verification requests or webhooks.

## Operator TUI

Build the package, then launch the interactive console:

```bash
npm run build
npm run tui
```

Xwrite requires an interactive terminal. Its main prompt supports:

| Command | Action |
| --- | --- |
| `/verify` | Start the guided invoice verification workflow. |
| `/status` | Check provider, payment, signer, and submission readiness without displaying values. |
| `/help` or `/?` | Show commands and safety boundaries. |
| `/clear` | Clear and redraw the session. |
| `/quit` or `/exit` | Exit Xwrite. |

Within a verification dialog, use the arrow keys or `j`/`k` to move, Enter to select, and `q` to cancel. Xwrite provides:

- a guided verification workflow;
- settled-order and controlled testnet payment modes;
- verify-and-sign or Stellar testnet submission modes;
- configuration readiness checks that show only variable names and configured/missing status;
- explicit confirmation before execution.

A verify-and-sign run requires typing `RUN`. A run that can send a Stellar transaction requires typing `SUBMIT`. Canceling the confirmation returns to the main menu without running verification.

The TUI calls the same verification path as the flag-based CLI below. It does not display private keys, Stellar seeds, merchant passwords, or API token values.

## Operator CLI

Build the package, then run:

```bash
npm run build
npm run start -- --request ./request.json --order-id ord_123 --submit
```

Use `--skip-payment` only for a controlled testnet run. It must be explicit and cannot be combined with `--order-id`. Omitting `--submit` runs verification and stores the evidence report without sending a Soroban transaction.

The CLI exits with code `0` after a signed result, `2` when required evidence is unavailable, and `1` for invalid input, configuration, payment, or submission errors. Its output contains identifiers, hashes, scores, and transaction metadata. It never prints configured secrets.

The request JSON shape is:

```json
{
  "invoiceId": "64 hexadecimal characters",
  "documentPath": "./invoice.pdf",
  "amountMinor": "5000000000",
  "currency": "NGN",
  "invoiceDate": "2026-11-02",
  "dueDate": "2026-12-02",
  "buyer": {
    "address": "G...",
    "name": "Buyer legal name",
    "rcNumber": "RC100"
  },
  "seller": {
    "address": "G...",
    "name": "Seller legal name",
    "rcNumber": "RC200"
  }
}
```

`documentPath` is resolved relative to the request JSON file. `invoiceId` may include a `0x` prefix. `amountMinor` is a string so large integer values do not lose precision in JSON.

## Workspace commands

| Command | Result |
| --- | --- |
| `npm run typecheck` | Runs TypeScript checking in each workspace. |
| `npm test` | Runs the Vitest suite once. |
| `npm run build` | Compiles the agent workspace to `packages/agent/dist/`. |

These commands run without live environment values.

## Public-key helper

The one operator script derives the public key stored in the agent registry:

```bash
node --env-file=.env scripts/print-pubkey.ts
```

Input:

- `AGENT_EVM_PRIVATE_KEY`: a `0x`-prefixed 32-byte secp256k1 private key.

Output:

- Stdout: one `0x`-prefixed 65-byte uncompressed public key.
- Stderr: the derived EVM address for reference.

The script exits non-zero when the key is missing, malformed, or does not produce a `0x04`-prefixed uncompressed public key. It does not print the private key.

The public key is safe to pass to the registry admin. Do not add it to `.env`; it is a contract registration argument, not a secret configuration value.

## Library entrypoint

`packages/agent/src/index.ts` exports configuration, evidence sources, scoring, attestation functions, evidence stores, the verification pipeline, Soroban submission, ERC-8004 identity helpers, and merchant payment helpers.

Example import after building the workspace:

```ts
import {
  FileEvidenceStore,
  scoreInvoice,
  signAttestation,
  submitAttestation,
  verifyInvoice,
} from "@underwrite/agent";
```

Callers must supply the request data, validated subsystem configuration, search provider, evidence store, and key material. The repository does not wire these functions into a long-running process.
