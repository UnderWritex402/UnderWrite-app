# Attestation Client Reference

The attestation client is split between `attestation.ts` and `submit.ts`.

## Build a payload

```ts
import { buildAttestationPayload } from "@underwrite/agent";

const encoded = buildAttestationPayload({
  invoiceId: `0x${"7f".repeat(32)}`,
  riskScore: 1250,
  evidenceHash: `0x${"ab".repeat(32)}`,
  agentId: "underwrite_v1",
  nonce: 42n,
});
```

Return type:

```ts
{
  payload: `0x${string}`;
  digest: `0x${string}`;
}
```

`payload` is the full XDR `ScVal`. `digest` is `keccak256(payload)`.

The function rejects:

- An invoice ID or evidence hash that is not exactly 32 bytes of prefixed hex.
- A risk score outside `0`–`10000` or a fractional score.
- An agent ID outside the Soroban symbol rules.
- A nonce outside the unsigned 64-bit range.

## Derive a nonce

```ts
import { deriveNonce } from "@underwrite/agent";

const nonce = deriveNonce(agentId, invoiceId, evidenceHash);
```

The function hashes the fixed domain, agent ID, invoice ID, and evidence hash, then uses the leading 8 bytes as a `u64`. The same inputs return the same nonce.

## Sign

```ts
import { signAttestation } from "@underwrite/agent";

const signed = await signAttestation(fields, privateKey);
```

`privateKey` is a `0x`-prefixed 32-byte secp256k1 key. `SignedAttestation` contains all input fields plus:

```ts
{
  payload: `0x${string}`;
  digest: `0x${string}`;
  signature: `0x${string}`;
  recoveryId: number;
}
```

The signature is 65 bytes. The last byte is normalized to `0` or `1` for Soroban recovery.

## Submit

```ts
import { submitAttestation, submissionConfig } from "@underwrite/agent";

const result = await submitAttestation(signed, submissionConfig());
```

Return type:

```ts
{
  transactionHash: string;
  ledger: number | null;
  confirmationMs: number;
}
```

The client simulates, assembles, signs, sends, and polls the transaction. `SubmissionError.phase` is `simulate`, `send`, or `confirm`. `AlreadyAttestedError` identifies the replay-guard case separately.

## Evidence report helpers

`canonicalize` sorts object keys and serializes big integers as decimal strings. `hashEvidenceReport` omits the report's own `evidenceHash` field before hashing. Store the same canonical report bytes that were hashed.

## Current limitations

- The client does not yet read the registry before signing.
- It does not persist transaction reconciliation state across restarts.
- It uses one source account without a concurrency queue.
- The installed Stellar SDK needs compatibility work for the current live RPC simulation response.
- Live end-to-end evidence has not been recorded.
