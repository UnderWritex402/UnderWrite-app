# Local Setup

## Requirements

- Node.js 20 or newer.
- npm with lockfile support.
- Git.

The unit test suite does not require live API keys or a Stellar account.

## Install and verify

These commands were run successfully from a fresh clone:

```bash
git clone https://github.com/UnderWritex402/UnderWrite-app.git
cd UnderWrite-app
npm ci
npm run typecheck
npm test
npm run build
```

Expected test summary at the time these docs were written:

```text
Test Files  11 passed (11)
Tests       122 passed (122)
```

`npm ci` currently reports 11 dependency advisories: 1 moderate, 8 high, and 2 critical. Review reachability before changing versions; do not use `npm audit fix --force` without checking breaking changes.

## Repository layout

```text
packages/agent/src/
  attestation.ts       XDR payload, evidence hash, nonce, signature
  config.ts            subsystem environment validation
  evidenceStore.ts     canonical off-chain reports
  payment.ts           merchant payment checks
  pipeline.ts          evidence collection and signing flow
  scoring.ts           risk-signal calculation
  submit.ts            Soroban transaction flow
  sources/             CAC, history, web, and document checks
scripts/
  print-pubkey.ts      derives the registry public key
```

## Configuration

Copy `.env.example` only when working on a live integration. Replace example or empty fields locally and keep `.env` untracked.

Configuration is loaded lazily by subsystem. For example, document-forensics tests do not need a Stellar seed, and Soroban submission does not need merchant portal credentials.

## Runtime status

The package builds a library at `packages/agent/dist/`. There is no `server.ts` or general command-line service in the current source. The workspace's `start` script points to `dist/server.js`, which is not produced by the current build; do not document it as a working entrypoint.
