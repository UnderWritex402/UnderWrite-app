# What is Underwrite

Underwrite is an invoice verification layer for Stellar. It gives TrusTrove a signed risk signal before an invoice can be listed for financing.

The current system has three parts:

- The [verification agent](https://github.com/UnderWritex402/UnderWrite-app) gathers evidence, calculates a risk signal, stores the evidence report, and signs an attestation.
- The [agent registry](https://github.com/UnderWritex402/UnderWrite-contract) stores the approved agent's secp256k1 public key and active status on Soroban.
- The [TrusTrove Invoice contract](https://github.com/TrusTrove/TrusTrove-contract) verifies the signature through `submit_attestation` and blocks `list_for_financing` when no attestation exists.

All three are needed for the full flow.

## Current status

Underwrite is testnet-only, pre-release, and unaudited. The MVP uses one admin-registered agent, `underwrite_v1`. An open agent registry is post-MVP work.

The end-to-end flow is in progress. Unit tests cover evidence collection, scoring, XDR encoding, signing, payment checks, and the Soroban submission state machine. No live demo evidence file exists yet.

## What the output means

The output is a risk signal expressed in basis points from `0` to `10000`. Higher values represent more observed risk under the current scoring rules. It is not a credit score, an approval, or a guarantee that an invoice will be paid.

The full evidence report stays off-chain. The attestation stores its 32-byte evidence hash so a reviewer holding the report can recompute the hash and compare it with the on-chain value.
