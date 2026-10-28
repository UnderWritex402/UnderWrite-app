# App issue backlog

These items were not filed in the first batch of 25 issues.

## `integration(soroban-client): submit a live testnet attestation`

Labels: `complexity:high`, `area:soroban-client`, `Stellar Wave`, `testing`

## Summary

Build a testnet harness that verifies one invoice, signs the real XDR payload, submits it to the deployed Invoice contract, and records the transaction hash. Keep secrets in the runtime environment only.

## Why it matters

Unit tests prove the client state machine, but only a live submission proves the app and deployed Invoice contract agree on argument and payload encoding.

## Acceptance Criteria

- [ ] The harness reaches a successful confirmed transaction with a real 32-byte invoice ID.
- [ ] Output contains the hash and testnet Explorer link but no key material or environment values.

## Tech Stack

TypeScript 5.9, Node.js 20+, @stellar/stellar-sdk, Soroban testnet, Vitest 3.2.7.

## Depends on

TrusTrove Part 1D `submit_attestation` must be landed and deployed on testnet.

---

## `integration(attestation): reject an unregistered signing key`

Labels: `complexity:high`, `area:attestation`, `Stellar Wave`, `testing`

## Summary

Submit a correctly encoded attestation signed by a secp256k1 key that is not registered under the payload's agent ID. Assert the exact testnet rejection.

## Why it matters

The registry lookup is the trust boundary that prevents arbitrary agents from creating listing-eligible risk signals.

## Acceptance Criteria

- [ ] The payload passes local encoding checks but fails the on-chain signer check.
- [ ] The failure is captured as a typed contract rejection with no transaction retry.

## Tech Stack

TypeScript 5.9, Node.js 20+, @stellar/stellar-sdk, viem 2.55.19, Soroban testnet.

## Depends on

TrusTrove Part 1D `submit_attestation` must be landed and deployed on testnet.

---

## `integration(attestation): reject a deactivated agent`

Labels: `complexity:high`, `area:attestation`, `Stellar Wave`, `testing`

## Summary

Exercise the Invoice contract with a signature from an agent that exists in the registry but is inactive. Use a dedicated reversible test fixture rather than the live `underwrite_v1` record.

## Why it matters

Deactivation must take effect at the listing gate even when the signature and payload are otherwise valid.

## Acceptance Criteria

- [ ] A dedicated active test agent succeeds before deactivation.
- [ ] The same signer is rejected after deactivation, and test state is safely restored when possible.

## Tech Stack

TypeScript 5.9, Node.js 20+, @stellar/stellar-sdk, Soroban testnet registry and Invoice contracts.

## Depends on

TrusTrove Part 1D must be deployed, and an admin-safe reversible test-agent procedure must be approved.

---

## `integration(soroban-client): confirm attestation state and events`

Labels: `complexity:high`, `area:soroban-client`, `Stellar Wave`, `testing`

## Summary

After a successful transaction, read the Invoice contract's stored attestation and emitted event, then compare invoice ID, score, evidence hash, and agent ID with the submitted payload.

## Why it matters

Transaction success alone does not prove indexers and listing logic can retrieve the expected risk signal.

## Acceptance Criteria

- [ ] The harness reads and validates stored attestation fields after confirmation.
- [ ] It validates the documented event topics and data against the same fields.

## Tech Stack

TypeScript 5.9, Node.js 20+, @stellar/stellar-sdk, Soroban testnet RPC.

## Depends on

TrusTrove Part 1D must expose and document the deployed storage and event interface.

---

## `feat(verification): return a score explanation`

Labels: `complexity:medium`, `area:verification`, `Stellar Wave`, `enhancement`

## Summary

Add a stable, plain-language explanation derived from `ScoreBreakdown` that names each source contribution and unavailable-source penalty. Keep the numeric risk signal unchanged.

## Why it matters

Sellers and reviewers need to see why a risk signal changed without reading internal score objects or treating it as a credit score.

## Acceptance Criteria

- [ ] Every source contribution and penalty maps to a deterministic explanation entry.
- [ ] Worked tests cover clean, adverse, cold-start, and insufficient-evidence outcomes.

## Tech Stack

TypeScript 5.9, Node.js 20+, Vitest 3.2.7.

---

## `test(web-research): add recorded provider contract fixtures`

Labels: `complexity:medium`, `area:web-research`, `Stellar Wave`, `testing`

## Summary

Add sanitized recorded response fixtures for Brave, Tavily, and Serper, including missing fields, rate-limit errors, and provider schema changes. Keep API credentials and personal data out of fixtures.

## Why it matters

Handwritten unit objects cover the normal shape but do not detect drift in real provider envelopes.

## Acceptance Criteria

- [ ] Each provider has at least one sanitized success and failure fixture.
- [ ] Fixture tests prove schema drift becomes unavailable evidence rather than a clean result.

## Tech Stack

TypeScript 5.9, Node.js 20+, Zod 3.25.76, Vitest 3.2.7.
