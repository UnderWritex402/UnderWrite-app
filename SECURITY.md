# Security Policy

## Supported versions

Underwrite is a pre-release project deployed on Stellar testnet only. No mainnet deployment exists.

| Version | Supported |
| --- | --- |
| `0.1.x` | Yes |
| Earlier versions | No |

## Audit status

Unaudited.

## In scope

- Exposure or misuse of the agent secp256k1 key, Stellar submitter seed, merchant credentials, or provider API keys.
- Attestation parsing, XDR encoding, hashing, signing, or submission errors that make Soroban accept or reject the wrong risk signal.
- x402 payment replay, double use of one settled order, or a payment gate bypass that starts verification before settlement.
- Unsafe outbound requests or SSRF through CAC lookup, TrusTrove indexer, web research, or merchant portal configuration.
- Invoice document-forensics inputs that cause unintended file, process, or network access.
- Secrets or bearer tokens written to logs, errors, evidence reports, or repository files.
- Dependency vulnerabilities with a demonstrated path through the verification agent.

## Out of scope

- Testnet token value.
- Issues in GOAT Network, Stellar, Soroban, search providers, CAC providers, or other third-party services themselves.
- Social engineering.
- Denial of service by request volume against public endpoints.
- Findings with no demonstrated impact.

## How to report

Use GitHub private vulnerability reporting through this repository's Security Advisories. Do not open a public issue.

Include affected code, reproduction steps, impact, and any suggested fix. Do not include live secrets or private keys.

## Response timeline

| Stage | Target |
| --- | --- |
| Acknowledge report | Within 3 days |
| Complete initial triage | Within 7 days |
| Set a fix target | Within 14 days after triage |
| Coordinate disclosure | After a fix is available, normally within 30 days |

## Disclosure policy

Disclosure is coordinated with the reporter after a fix is available. Reporters receive credit unless they decline it.
