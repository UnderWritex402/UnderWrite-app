#!/usr/bin/env bash
set -euo pipefail

REPO="UnderWritex402/UnderWrite-app"
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
elif [[ $# -ne 0 ]]; then
  echo "usage: $0 [--dry-run]" >&2
  exit 2
fi

create_issue() {
  local title="$1"
  local labels="$2"
  local body
  body="$(cat)"

  if [[ "$DRY_RUN" == "true" ]]; then
    printf '\nTITLE: %s\nLABELS: %s\n%s\n' "$title" "$labels" "$body"
  else
    gh issue create \
      --repo "$REPO" \
      --title "$title" \
      --label "$labels" \
      --body "$body"
  fi
}

create_issue \
  "test(soroban-client): reject malformed hexadecimal arguments" \
  "complexity:low,area:soroban-client,Stellar Wave,testing" <<'BODY'
## Summary
Add negative tests and strict validation for non-hex, odd-length, and empty `invoiceId`, payload, and signature values before building Soroban `ScVal` arguments. `Buffer.from(value, "hex")` currently accepts some malformed strings by truncating them.

## Why it matters
Malformed bytes should fail locally with a clear error instead of producing a different attestation argument or paying for a rejected simulation.

## Acceptance Criteria
- [ ] Non-hex and odd-length values are rejected before any RPC call.
- [ ] Errors name the invalid field and expected encoding.

## Tech Stack
TypeScript 5.9, Node.js 20+, @stellar/stellar-sdk 13.3.0, Vitest 3.2.7.
BODY

create_issue \
  "fix(soroban-client): classify invalid submitter seeds" \
  "complexity:low,area:soroban-client,Stellar Wave,bug" <<'BODY'
## Summary
Catch failures from `Keypair.fromSecret` and return a typed configuration or submission error without echoing the seed. Add tests for malformed and wrong-key-type inputs.

## Why it matters
The current raw SDK exception is outside the submission phase taxonomy and can make operators expose secret-bearing configuration while debugging.

## Acceptance Criteria
- [ ] Invalid seeds fail before account or RPC access with a stable error type.
- [ ] The error and logs never include the supplied secret value.

## Tech Stack
TypeScript 5.9, Node.js 20+, @stellar/stellar-sdk 13.3.0, Vitest 3.2.7.
BODY

create_issue \
  "fix(soroban-client): poll once before sleeping" \
  "complexity:low,area:soroban-client,Stellar Wave,enhancement,good first issue" <<'BODY'
## Summary
Query `getTransaction` immediately after `sendTransaction` before the first polling delay. Keep later polls at the configured interval and update timing tests.

## Why it matters
Fast testnet confirmations currently wait an avoidable second before the client can report success.

## Acceptance Criteria
- [ ] The first confirmation read happens without calling `sleep`.
- [ ] Later `NOT_FOUND` results use the configured interval and timeout.

## Tech Stack
TypeScript 5.9, Node.js 20+, @stellar/stellar-sdk 13.3.0, Vitest 3.2.7.
BODY

create_issue \
  "fix(soroban-client): decode failed transaction diagnostics" \
  "complexity:low,area:soroban-client,Stellar Wave,bug" <<'BODY'
## Summary
Decode failed transaction result XDR into a stable diagnostic instead of searching base64 text for replay markers. Preserve the raw XDR separately for debugging.

## Why it matters
The current replay classifier cannot reliably find contract error names in base64, so an already-attested result can be reported as an unknown ledger failure.

## Acceptance Criteria
- [ ] Known contract errors are decoded and mapped to typed submission errors.
- [ ] Unknown result XDR remains available without being mistaken for plain text.

## Tech Stack
TypeScript 5.9, Node.js 20+, @stellar/stellar-sdk 13.3.0, Vitest 3.2.7.
BODY

create_issue \
  "fix(soroban-client): verify the configured Stellar network" \
  "complexity:low,area:soroban-client,Stellar Wave,security" <<'BODY'
## Summary
Add a preflight that checks the RPC network passphrase or network identity against `STELLAR_NETWORK_PASSPHRASE` before building a transaction. Report a configuration error on mismatch.

## Why it matters
A mismatched RPC and passphrase signs an unusable transaction and can send operators to the wrong network while they investigate.

## Acceptance Criteria
- [ ] Submission refuses a verified network mismatch before signing.
- [ ] Tests cover matching testnet configuration and a mismatched passphrase.

## Tech Stack
TypeScript 5.9, Node.js 20+, @stellar/stellar-sdk 13.3.0, Vitest 3.2.7.
BODY

create_issue \
  "fix(verification): validate indexed invoice IDs" \
  "complexity:low,area:verification,Stellar Wave,bug" <<'BODY'
## Summary
Change the platform-history duplicate schema from arbitrary strings to exact 0x-prefixed 32-byte invoice IDs. Add fixtures for invalid length, invalid hex, and valid leading-zero IDs.

## Why it matters
Duplicate detection compares indexer output with the on-chain `BytesN<32>` invoice ID and should not accept identifiers the contract can never use.

## Acceptance Criteria
- [ ] Invalid indexer invoice IDs make the source unavailable with a clear reason.
- [ ] Valid 32-byte IDs round-trip without numeric coercion.

## Tech Stack
TypeScript 5.9, Node.js 20+, Zod 3.25.76, Vitest 3.2.7.
BODY

create_issue \
  "test(cli): cover public-key derivation output" \
  "complexity:low,area:cli,Stellar Wave,testing,good first issue" <<'BODY'
## Summary
Add subprocess tests for `scripts/print-pubkey.ts`. Cover missing input, malformed key input, a valid 65-byte uncompressed public key, and separation of stdout from diagnostic stderr.

## Why it matters
The script supplies the exact key bytes registered on Soroban, and a formatting regression can register the wrong signer.

## Acceptance Criteria
- [ ] Valid output is exactly one 0x-prefixed 65-byte public key on stdout.
- [ ] Invalid inputs exit non-zero without printing private-key material.

## Tech Stack
TypeScript 5.9, Node.js 20+, viem 2.55.19, Vitest 3.2.7.
BODY

create_issue \
  "docs(soroban-client): document submission recovery" \
  "complexity:low,area:docs,Stellar Wave,documentation,good first issue" <<'BODY'
## Summary
Document the simulate, assemble, send, and confirm phases and the operator action for each failure class. Include the rule for checking a timed-out hash before resubmitting.

## Why it matters
Blind retry after an uncertain confirmation can hit the on-chain replay guard and obscure whether the first attestation settled.

## Acceptance Criteria
- [ ] Each `SubmissionPhase` has a concrete recovery procedure.
- [ ] The guide includes transaction-hash and Stellar Explorer lookup steps without secrets.

## Tech Stack
TypeScript 5.9, Node.js 20+, @stellar/stellar-sdk 13.3.0, Markdown.
BODY

create_issue \
  "fix(config): validate the registry contract setting" \
  "complexity:low,area:soroban-client,Stellar Wave,bug" <<'BODY'
## Summary
Add `AGENT_REGISTRY_CONTRACT` to the validated configuration used by registry reads. The example environment contains the name, but `config.ts` does not parse it.

## Why it matters
Agent status and key checks need one validated registry ID instead of an untyped environment value that can drift from documentation.

## Acceptance Criteria
- [ ] The setting is validated as a Soroban contract ID in the relevant subsystem schema.
- [ ] Required and malformed-value tests are added without reading unrelated secrets.

## Tech Stack
TypeScript 5.9, Node.js 20+, Zod 3.25.76, Vitest 3.2.7.
BODY

create_issue \
  "test(verification): pin CAC provider authentication headers" \
  "complexity:low,area:verification,Stellar Wave,testing,good first issue" <<'BODY'
## Summary
Add tests for Dojah, Mono, and Zeeh authentication headers, including Dojah's optional application ID. Assert API keys are placed only in headers and never in URLs or result objects.

## Why it matters
Provider adapters have different authentication schemes, and a header regression can leak a paid credential into logs or query strings.

## Acceptance Criteria
- [ ] Each provider's exact header names and bearer format are tested.
- [ ] Tests confirm credentials are absent from request URLs and normalized results.

## Tech Stack
TypeScript 5.9, Node.js 20+, Zod 3.25.76, Vitest 3.2.7.
BODY

create_issue \
  "fix(soroban-client): wrap RPC failures by submission phase" \
  "complexity:medium,area:soroban-client,Stellar Wave,bug" <<'BODY'
## Summary
Wrap exceptions from account loading, simulation, sending, and polling in `SubmissionError` with the correct phase and safe diagnostics. Preserve the original cause without exposing credentials.

## Why it matters
Network exceptions currently bypass the documented phase taxonomy, so callers cannot choose a safe retry or alert policy.

## Acceptance Criteria
- [ ] Every RPC call failure maps to a stable phase and error code or cause.
- [ ] Tests cover transport failures at account, simulate, send, and confirm steps.

## Tech Stack
TypeScript 5.9, Node.js 20+, @stellar/stellar-sdk 13.3.0, Vitest 3.2.7.
BODY

create_issue \
  "feat(soroban-client): enforce a transaction fee cap" \
  "complexity:medium,area:soroban-client,Stellar Wave,enhancement" <<'BODY'
## Summary
Add a configured maximum fee and reject a simulated transaction whose assembled resource fee exceeds it. Report the base, resource, and total fee without signing.

## Why it matters
The client currently accepts the simulation's resource fee without an operator-defined bound, so a bad footprint or RPC response can drain the submitter account.

## Acceptance Criteria
- [ ] A validated fee-cap setting is enforced after simulation and before signing.
- [ ] Tests cover fees below, equal to, and above the cap.

## Tech Stack
TypeScript 5.9, Node.js 20+, @stellar/stellar-sdk 13.3.0, Zod 3.25.76, Vitest 3.2.7.
BODY

create_issue \
  "feat(attestation): preflight payload and signature consistency" \
  "complexity:medium,area:attestation,Stellar Wave,security" <<'BODY'
## Summary
Before submission, decode the XDR payload and verify its invoice ID, risk score, evidence hash, agent ID, and nonce match the `SignedAttestation` fields. Recompute the digest and recover the signing key from the signature.

## Why it matters
`submitAttestation` is public and can receive an object assembled outside `signAttestation`; inconsistent metadata should fail before fees are spent.

## Acceptance Criteria
- [ ] Every duplicated field is compared with the decoded payload.
- [ ] Digest or signature mismatch is rejected locally with negative tests.

## Tech Stack
TypeScript 5.9, Node.js 20+, @stellar/stellar-sdk 13.3.0, viem 2.55.19, Vitest 3.2.7.
BODY

create_issue \
  "fix(soroban-client): align the SDK with current Soroban RPC" \
  "complexity:medium,area:soroban-client,Stellar Wave,bug" <<'BODY'
## Summary
Reproduce and fix the current SDK parser failure against the live testnet `simulateTransaction` response. Upgrade or adapt `@stellar/stellar-sdk` and pin a compatible version with regression coverage.

## Why it matters
The installed SDK 13.3.0 can build requests but failed to parse a current testnet simulation response, which blocks live submission even when the contract call is valid.

## Acceptance Criteria
- [ ] A read-only live simulation response parses without `Bad union switch` or protocol errors.
- [ ] Unit fixtures pin the response shape and CI uses the compatible SDK version.

## Tech Stack
TypeScript 5.9, Node.js 20+, @stellar/stellar-sdk, Vitest 3.2.7, Soroban testnet RPC.
BODY

create_issue \
  "fix(soroban-client): serialize source-account submissions" \
  "complexity:medium,area:soroban-client,Stellar Wave,bug" <<'BODY'
## Summary
Add source-account sequencing or a queue so concurrent attestations do not build with the same account sequence number. Test two overlapping submissions and retry after `tx_bad_seq` only when safe.

## Why it matters
The pipeline can verify invoices concurrently, but one Stellar submitter account cannot send parallel transactions with the same sequence.

## Acceptance Criteria
- [ ] Concurrent calls allocate or serialize valid source sequences.
- [ ] Tests prove both calls settle or return a typed, recoverable sequence error.

## Tech Stack
TypeScript 5.9, Node.js 20+, @stellar/stellar-sdk 13.3.0, Vitest 3.2.7.
BODY

create_issue \
  "feat(cli): add attestation submit and status commands" \
  "complexity:medium,area:cli,Stellar Wave,enhancement" <<'BODY'
## Summary
Add a CLI that submits an existing signed attestation and checks a transaction hash without rerunning verification. Use the validated configuration and print structured, secret-free output.

## Why it matters
Operators need a safe recovery path for timed-out transactions and a reproducible way to exercise the Soroban client outside application wiring.

## Acceptance Criteria
- [ ] `submit` accepts a signed-attestation file and prints the transaction hash.
- [ ] `status` reports pending, success, or failure without requiring a private key for reads.

## Tech Stack
TypeScript 5.9, Node.js 20+, @stellar/stellar-sdk 13.3.0, Vitest 3.2.7.
BODY

create_issue \
  "feat(soroban-client): generate registry client bindings" \
  "complexity:medium,area:soroban-client,Stellar Wave,enhancement" <<'BODY'
## Summary
Generate and version a TypeScript client for the Underwrite agent-registry contract spec. Replace hand-shaped registry read types in new preflight code with generated types.

## Why it matters
Typed bindings keep `get_agent`, `AgentInfo`, and future admin changes aligned with the Rust contract.

## Acceptance Criteria
- [ ] One documented command regenerates the client from the current contract Wasm or spec.
- [ ] CI detects stale bindings or verifies generation succeeds.

## Tech Stack
TypeScript 5.9, Node.js 20+, @stellar/stellar-sdk 13.3.0, Stellar CLI.
BODY

create_issue \
  "fix(verification): make evidence writes atomic and private" \
  "complexity:medium,area:verification,Stellar Wave,security" <<'BODY'
## Summary
Write evidence reports through a temporary file and atomic rename, with restrictive directory and file modes. Detect an existing hash with different content instead of overwriting it.

## Why it matters
Interrupted writes can leave an on-chain evidence hash pointing to invalid JSON, and default permissions may expose invoice evidence to other local users.

## Acceptance Criteria
- [ ] A failed write cannot replace a valid report with partial content.
- [ ] File modes and hash-collision behavior have platform-appropriate tests.

## Tech Stack
TypeScript 5.9, Node.js 20+, Node filesystem APIs, Vitest 3.2.7.
BODY

create_issue \
  "fix(verification): bound document-forensics input" \
  "complexity:medium,area:verification,Stellar Wave,security" <<'BODY'
## Summary
Set a documented maximum document size and avoid converting an unbounded invoice to one large Latin-1 string. Add adversarial fixtures for large, truncated, and binary-heavy PDFs.

## Why it matters
Document forensics runs before signing and can consume excessive memory on attacker-controlled invoice bytes.

## Acceptance Criteria
- [ ] Oversized documents fail with an explicit unavailable reason before full string conversion.
- [ ] Boundary and malformed-file fixtures keep runtime and memory bounded.

## Tech Stack
TypeScript 5.9, Node.js 20+, Node buffer APIs, Vitest 3.2.7.
BODY

create_issue \
  "fix(web-research): bound provider concurrency" \
  "complexity:medium,area:web-research,Stellar Wave,enhancement" <<'BODY'
## Summary
Replace the 12-query `Promise.all` burst with configurable bounded concurrency and provider-aware backoff. Preserve the rule that a partial sweep is unavailable, not clean.

## Why it matters
Bursting every query at once increases rate-limit failures and can turn a valid verification into missing evidence.

## Acceptance Criteria
- [ ] A configurable limit caps simultaneous provider requests.
- [ ] Tests cover rate limits, retry exhaustion, and no partial-success misreporting.

## Tech Stack
TypeScript 5.9, Node.js 20+, Zod 3.25.76, Vitest 3.2.7.
BODY

create_issue \
  "feat(attestation): verify active registry identity before signing" \
  "complexity:high,area:attestation,Stellar Wave,security" <<'BODY'
## Summary
Read `get_agent` for `AGENT_ID` before a live run and confirm the record is active and its 65-byte key matches `AGENT_EVM_PRIVATE_KEY`. Refuse signing and submission on any mismatch.

## Why it matters
The pipeline can currently spend money and produce an attestation that the listing gate will reject because the agent is missing, revoked, or registered under another key.

## Acceptance Criteria
- [ ] Startup or live-run preflight compares the derived public key with the registry record.
- [ ] Missing, inactive, and mismatched records have distinct secret-free errors and tests.

## Tech Stack
TypeScript 5.9, Node.js 20+, @stellar/stellar-sdk 13.3.0, viem 2.55.19, Vitest 3.2.7.
BODY

create_issue \
  "feat(soroban-client): add durable transaction reconciliation" \
  "complexity:high,area:soroban-client,Stellar Wave,enhancement" <<'BODY'
## Summary
Persist invoice ID, payload digest, transaction hash, and submission phase so a process restart resumes confirmation instead of sending again. Define terminal and manual-review states.

## Why it matters
The current in-memory poll loop loses all state on restart, which creates a replay risk and no reliable answer about whether fees were spent.

## Acceptance Criteria
- [ ] Restart recovery checks saved hashes before any new transaction is built.
- [ ] Tests cover crashes after send, success while offline, ledger failure, and unresolved timeout.

## Tech Stack
TypeScript 5.9, Node.js 20+, @stellar/stellar-sdk 13.3.0, durable local storage, Vitest 3.2.7.
BODY

create_issue \
  "test(attestation): add cross-language XDR property tests" \
  "complexity:high,area:attestation,Stellar Wave,testing" <<'BODY'
## Summary
Generate varied valid payloads in TypeScript and decode or re-encode them with a small Rust Soroban test harness. Cover all 32 invoice byte positions, numeric boundaries, symbol lengths, and leading zeros.

## Why it matters
Pinned fixtures catch one payload, while property tests detect layout drift across the JavaScript and Soroban implementations.

## Acceptance Criteria
- [ ] TypeScript-generated payloads decode to identical Rust field values across generated cases.
- [ ] Invalid widths and numeric boundaries fail consistently on both sides.

## Tech Stack
TypeScript 5.9, Node.js 20+, @stellar/stellar-sdk 13.3.0, Rust 2021, soroban-sdk 27.0.6, Vitest 3.2.7.
BODY

create_issue \
  "ci(soroban-client): monitor testnet RPC compatibility" \
  "complexity:high,area:ci,Stellar Wave,testing" <<'BODY'
## Summary
Add a scheduled, read-only testnet job that fetches network data and simulates a registry `get_agent` call using the installed Stellar SDK. Alert on protocol or XDR parser incompatibility.

## Why it matters
Soroban RPC and SDK protocol versions can drift between releases; this checkout already encountered a live response that the installed parser could not decode.

## Acceptance Criteria
- [ ] The job makes no write and uses no secret account material.
- [ ] Failures preserve safe response metadata and clearly identify SDK or RPC versions.

## Tech Stack
TypeScript 5.9, Node.js 20+, @stellar/stellar-sdk, GitHub Actions, Soroban testnet RPC.
BODY

create_issue \
  "fix(payments): persist invoice payment consumption" \
  "complexity:high,area:payments,Stellar Wave,security,bug" <<'BODY'
## Summary
Add a durable idempotency record that binds one settled order to one invoice verification and records when work starts and completes. Reject reuse after restart or across concurrent workers.

## Why it matters
`requireSettledPayment` verifies current settlement and optional invoice metadata, but it does not record that an order has already paid for a completed report.

## Acceptance Criteria
- [ ] One order cannot unlock two invoice verifications, including after restart and under concurrency.
- [ ] Recovery rules distinguish in-progress work from a completed report without handling live keys in tests.

## Tech Stack
TypeScript 5.9, Node.js 20+, @goatnetwork/agentkit 0.2.3, durable idempotency storage, Vitest 3.2.7.
BODY
