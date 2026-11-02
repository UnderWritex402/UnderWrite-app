# Changelog

All notable changes to this project are documented in this file.

## 0.1.0 - 2026-11-02

### Added

- Invoice verification pipeline using platform history, CAC lookup, web research, and document forensics.
- Integer basis-point risk scoring with required-source checks and unavailable-source penalties.
- secp256k1 attestation signing and Soroban `submit_attestation` transaction support.
- ERC-8004 identity and x402 merchant payment integrations.
- Filesystem-backed evidence reports addressed by their evidence hash.
- Operator CLI with settled-payment enforcement, explicit testnet payment bypass, and optional on-chain submission.
- CI, contributor documentation, security policy, Apache-2.0 license, issue backlog, and protocol documentation.
- 125 tests across 12 test files.

### Known limitations

- Testnet only and unaudited.
- CAC remains a required evidence source and is not configured in the maintainer's current local environment.
- No accepted end-to-end attestation and financing-listing transaction has been recorded yet.
- `scripts/demo.sh` and `docs/demo/e2e-evidence.md` are not included in this release.
