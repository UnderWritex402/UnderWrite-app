# Verification Lifecycle

## 1. Receive a paid request

TrusTrove supplies an order reference and invoice data. `requireSettledPayment` re-reads the order from the authenticated merchant API. Research starts only when the status is `settled`.

A settled order for a different invoice is rejected when `expectedInvoiceId` is supplied. The current code does not yet persist that an order has already been consumed; durable payment idempotency is tracked as follow-up work.

## 2. Gather evidence

`gatherEvidence` runs these sources:

- TrusTrove platform history and duplicate-document lookup.
- CAC lookup for the selected party.
- Web research for the buyer and seller.
- Local document forensics.

Remote source failures become `unavailable` results with a reason. A partial web sweep is not reported as a clean sweep.

## 3. Calculate the risk signal

`scoreInvoice` returns one of two outcomes:

- `scored`: a `riskScore` from `0` to `10000` and a source breakdown.
- `insufficient_evidence`: no score or signature, plus the missing sources and reason.

Underwrite stores the evidence report in both cases. It signs only a scored report.

## 4. Build and sign the attestation

The app hashes the canonical report, derives a deterministic `u64` nonce, and XDR-encodes `AttestationPayload`. It signs `keccak256(payload)` with the agent's secp256k1 key.

The deterministic nonce makes the same invoice and evidence produce the same payload. On-chain replay prevention comes from the Invoice contract's one-attestation-per-invoice storage check.

## 5. Submit to Soroban

`submitAttestation` loads the Stellar submitter account, simulates the call, assembles its resource footprint, signs the transaction, sends it, and polls for confirmation. The submitter pays the Stellar transaction fee but does not determine whether the attestation is trusted.

## 6. Apply the listing gate

After a valid attestation is stored, the invoice issuer can call:

```rust
list_for_financing(invoice_id: BytesN<32>, discount_bps: u32) -> bool
```

The call fails with `VerificationRequired` when the invoice has no attestation. It also checks status, issuer authorization, current buyer and issuer verification, and the 50% discount cap.

## Status note

The code paths and unit tests exist. A live testnet record covering every step has not been added to `docs/demo/e2e-evidence.md`, so this lifecycle must not be described as complete end to end.
