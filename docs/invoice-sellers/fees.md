# Fees

The intended listing model has two separate costs:

1. An x402 verification fee pays for the off-chain checks.
2. A Stellar transaction fee pays to submit the signed attestation.

## Verification fee model

TrusTrove fronts the x402 verification fee when the seller requests listing. It recoups that fee from invoice proceeds only if the invoice is financed.

Worked example:

- Verification fee: `2 USDC`.
- Invoice financing proceeds before recoupment: `1,000 USDC`.
- Seller receives after recoupment: `998 USDC`.

```text
1,000 USDC - 2 USDC = 998 USDC
```

If the invoice is verified but never financed, there are no financing proceeds from which to recoup the fee under this model.

The current app implements the merchant-side payment gate: it confirms an order is `settled` before research begins and can bind the settled order to an expected invoice ID. It does not implement TrusTrove's proceeds accounting. The exact live fee amount is deployment configuration and is not defined in this repository.

## Stellar transaction fee

`STELLAR_SUBMITTER_SECRET` belongs to the account that carries the signed attestation to Soroban. That account pays the network fee. It does not gain authority over the attestation contents.

The client simulates the transaction and uses the resource fee returned by Soroban RPC. A configurable maximum fee is not implemented yet, so operators should keep only testnet funds on the current submitter account.

## Failed verification

An unavailable required source produces `insufficient_evidence` and no signed attestation. Payment refund or retry policy is not implemented in this library and must be defined by the service that calls it.

All amounts on this page are examples except where a deployment publishes an explicit price. They do not set a protocol fee.
