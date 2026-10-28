# CLI / Service Reference

The current repository is a TypeScript library. It does not contain an HTTP server, webhook route, or general verification CLI.

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

## Known broken entry

`packages/agent/package.json` defines `npm start` as `node dist/server.js`, but no `server.ts` exists and the build does not produce `dist/server.js`. Treat this script as a stub until a service entrypoint is implemented.
