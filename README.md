# Underwrite — verification agent

Underwrite investigates an invoice before TrusTrove opens it for financing. It
researches the invoice across four independent data sources, produces an
evidence-backed **risk signal**, signs it, and submits a signed attestation
that gates whether the invoice can be listed at all.

It is not a credit score and does not claim to be one. Underwrite is not a
licensed credit bureau; the output is a risk signal backed by evidence you can
re-check yourself.

This repo is the off-chain agent service. Two other pieces complete the system:

| Piece | Where | Status |
|---|---|---|
| `agent-registry` (Soroban) | `underwrite-contract` | Deployed: `CB22R3OJUCQGHZCXH5WAONTURVMSGDIDGIGXA2XQ6UNXDUKYWZKVTER5` |
| `submit_attestation` + listing gate | `TrusTrove-contract` | Deployed: `CAMHFB4CRE3AEVP7ZJGZRQTVIUCZXHIP7KTLYTC44CN4S2QBAOQVAMZX` |
| Verification agent service | **this repo** | Built, 121 tests |

---

## Why this exists

TrusTrove's escrow and settlement work. Nothing checked whether an invoice was
real, whether the buyer could pay, or whether the seller had a history of
defaults. Investors were funding on faith.

That is a trust problem, not a settlement problem — and it is the kind of
problem an agent can actually do: research a question, get paid per task, and
build a reputation that is checkable by strangers.

---

## How a verification runs

```
TrusTrove lists an invoice
        │
        ▼
  x402 payment ──────────────► settled?  ── no ──► nothing happens
  (Underwrite is the merchant)    │
                                  yes
                                  ▼
        ┌─────────────────────────────────────────┐
        │  four sources, concurrently             │
        │                                         │
        │  1. CAC lookup      does it exist?      │
        │  2. platform history  seen this before? │
        │  3. web research    anything adverse?   │
        │  4. doc forensics   was it edited?      │
        └─────────────────────────────────────────┘
                                  │
                                  ▼
                    scoring.ts  →  risk signal (bps)
                                  │
                    ┌─────────────┴─────────────┐
             required source                 all present
              unavailable                       │
                    │                            ▼
                    ▼                   evidence report stored
          NO SCORE PRODUCED             (off-chain, hash-addressed)
          report stored anyway                   │
          listing stays blocked                  ▼
                                        sign with secp256k1
                                                 │
                                                 ▼
                                    submit_attestation on Soroban
                                    (permissionless — anyone can carry it)
                                                 │
                                                 ▼
                                    TrusTrove allows listing
```

### Payment is structural, not decorative

Research costs real money — the CAC lookup is billed per call. So
`payment.ts` gates the pipeline on an order actually reaching `settled`, the
only status that means funds moved on-chain. Nothing speculative runs.

Underwrite is the **merchant** in this relationship, not the payer: TrusTrove
pays, Underwrite collects. That is why this service uses AgentKit's
`x402-merchant` plugin rather than the payer-side one.

Webhooks are treated as untrusted. A webhook only says *which order to look
at*; whether it is paid is always re-read from the authenticated merchant API.
A forged webhook therefore achieves nothing beyond one wasted API read.

### Identity is structural too

The agent registers once in the ERC-8004 Identity Registry and thereafter
signs every attestation with the key that owns that identity. A reader can go
from an on-chain attestation to the agent's public reputation without
trusting anything this service says about itself.

Registry addresses are not configured anywhere in this repo. AgentKit resolves
them from the network name, so there is one source of truth and no address to
rot.

---

## The part that matters most: it refuses to guess

If a required data source is unreachable, Underwrite **does not produce a
number**. It returns `insufficient_evidence`, stores the report explaining
which source was down, and the invoice stays unlistable.

This is the whole point. A verification agent that emits a confident-looking
score when it could not actually check anything is worse than no agent —
it launders missing evidence into false assurance.

Required sources are `platformHistory`, `documentForensics`, and `cacLookup`
([`scoring.ts`](packages/agent/src/scoring.ts)). The first two cost nothing
and have no third-party dependency, so their failure means *our* pipeline
broke. CAC is required because it is the only proof the counterparty legally
exists — an invoice cleared without it has not really been verified.

**This has a cost worth stating plainly:** a CAC provider outage halts
verification, and therefore halts financing. That is a deliberate trade, and
relaxing it is a one-line edit to `REQUIRED_SOURCES` — a business decision,
not something a caller can route around.

Web research is *not* required. Adverse media is corroborating evidence, and
Nigerian company news coverage is thin enough that a clean sweep proves little.
Its absence is priced through a penalty instead of blocking the report.

Missing evidence always moves the signal **up**. It can never improve it.

---

## The risk signal

Integer basis points, 0–10000, higher is worse. No floating point anywhere in
the path — the contract stores a `u32`, and a float that disagreed with it
would be a silent mismatch.

| Source | Weight | What it answers |
|---|---:|---|
| Platform history | 3500 | Duplicate invoice? Has this buyer defaulted before? |
| CAC lookup | 2500 | Does this company legally exist, under this name? |
| Document forensics | 2500 | Was this PDF edited after it was created? |
| Web research | 1500 | Fraud, litigation, insolvency in public record? |

Every score comes with a `scoreBreakdown` giving each source's sub-score, its
weight, and the plain-language reasons behind it. The evidence report shows
its work; the number alone is never the deliverable.

A few deliberate choices:

- **A duplicate invoice document maxes out the signal immediately.** Financing
  the same receivable twice is the primary fraud in this market, and no amount
  of clean history offsets it.
- **Cold start scores 5000, not 0.** A counterparty with no history is
  *unproven*, not *clean*. Treating absence of evidence as good news is how
  you get defrauded by a brand-new shell company.
- **A clean document scores 500, not 0.** No evidence of tampering is not
  proof of authenticity.
- **The worst forensic signal dominates**, with others contributing at a
  discount — so five trivial signals cannot outweigh one serious one, and one
  serious one is not diluted by the absence of others.

---

## Attestation wire format

`payload` is the **XDR serialisation of TrusTrove's `AttestationPayload`
struct**. This is not a format Underwrite chooses: `submit_attestation` calls
`AttestationPayload::from_xdr(&env, &payload)` and hashes those same bytes, so
the encoding has to be byte-identical to what `soroban_sdk`'s `to_xdr`
produces on the Rust side.

```rust
pub struct AttestationPayload {
    pub domain_separator: BytesN<32>,  // "TrusTrove.InvoiceAttestation.v1_"
    pub invoice_id:       BytesN<32>,
    pub risk_score:       u32,         // basis points
    pub evidence_hash:    BytesN<32>,
    pub agent_id:         Symbol,
    pub nonce:            u64,
}
```

A `#[contracttype]` struct encodes as an `ScVal::Map` whose keys are the field
names as `ScSymbol`, **sorted lexicographically** — `agent_id`,
`domain_separator`, `evidence_hash`, `invoice_id`, `nonce`, `risk_score` — not
in declaration order. That ordering was confirmed against a live deployed
contract, not assumed: agent-registry's `get_agent` returns its `Agent` struct
as an `ScMap` with `active` before `pubkey`.

Passing the whole payload rather than a bare hash is what lets the contract
verify the `invoice_id` inside it matches the argument it was called with, so
a signature cannot be lifted onto a different invoice. The signed digest is
`keccak256(payload)`.

`invoice_id` is a `BytesN<32>`, never parsed as a number — a numeric
round-trip would drop leading zero bytes and collapse distinct ids onto the
same integer.

The signature is 65 bytes: `r ‖ s ‖ recovery_id`, where recovery id is **0 or
1** — not the 27/28 Ethereum convention — because the contract does
`sig_bytes[64] as u32` and hands it to `secp256k1_recover`.

The nonce is a `u64`, derived deterministically from `(agentId, invoiceId,
evidenceHash)` by truncating a keccak digest. Re-running verification on
unchanged evidence therefore produces byte-identical output, so a retry after
a dropped transaction cannot create a second, differently-signed attestation.
The nonce is not tracked on-chain — replay is prevented by the contract's
one-attestation-per-invoice storage check, and cross-invoice replay by the
`invoice_id` being inside the signed payload.

Full encoding and rationale: [`attestation.ts`](packages/agent/src/attestation.ts).

---

## Two keys, never conflated

| Key | Signs | If compromised |
|---|---|---|
| `AGENT_EVM_PRIVATE_KEY` | attestation **content**; ERC-8004 identity | forged risk signals |
| `STELLAR_SUBMITTER_SECRET` | the Soroban **transaction** carrying it | someone else pays gas |

Submission is permissionless by design: the contract decides validity from the
signature alone, so any funded Stellar account can carry an attestation. The
submitter key is a convenience, not an authority. Adding `require_auth` to
`submit_attestation` would reintroduce the trusted-submitter bottleneck the
design exists to avoid.

GOAT's docs call the first key `PRIVATE_KEY`. This service uses one name
only — `AGENT_EVM_PRIVATE_KEY` — mapped onto AgentKit at the single point of
construction, because `PRIVATE_KEY` sitting next to `STELLAR_SUBMITTER_SECRET`
in one `.env` is an incident waiting to happen.

---

## Layout

```
packages/agent/src/
├── sources/
│   ├── platformHistory.ts    duplicate detection, counterparty records
│   ├── documentForensics.ts  PDF structure, 8 tamper signals, no deps
│   ├── webResearch.ts        adverse-media method (backend-agnostic)
│   ├── searchProvider.ts     Brave / Tavily / Serper backends
│   └── cacLookup.ts          Dojah / Mono / Zeeh adapters
├── scoring.ts                integer bps, weights, required-source rule
├── attestation.ts            payload layout, canonical JSON, signing
├── evidenceStore.ts          off-chain reports, hash-addressed
├── pipeline.ts               sources → score → store → sign
├── submit.ts                 Soroban simulate → assemble → send → poll
├── payment.ts                x402 merchant gate
├── identity.ts               ERC-8004 registration and reputation
└── goat/runtime.ts           the one place AgentKit is constructed
```

The verification core knows nothing about GOAT. Sources, scoring, and
attestation import no AgentKit types, which is why they were built and fully
tested before any GOAT wiring existed — and why they stay testable without a
network.

---

## Running it

```bash
npm install
cp .env.example .env      # then fill it in
npm run typecheck
npm test                  # 121 tests, no network required
npm run build
```

Every test runs offline. External services are injected at the seams, so the
suite exercises real source modules rather than mocks of them.

### First run: register the identity

Leave `ERC8004_AGENT_ID` unset. `ensureRegistered` registers the agent and
reports the assigned id; set it in `.env` afterwards, and subsequent startups
verify ownership without writing anything.

There is a wrinkle worth knowing: AgentKit's `erc8004.register_agent` returns
only a `txHash`, while every other action needs the numeric `agentId`, and
there is no address→id lookup. Rather than guess at an event signature,
[`identity.ts`](packages/agent/src/identity.ts) `eth_call`s `register` to learn
the id the registry *would* assign, then confirms after the write that
`getAgentWallet(id)` really points at this agent. If confirmation fails, it
refuses to proceed and hands you the tx hash rather than continuing with an
unverified id.

### Before a live end-to-end run

1. `agent-registry` must hold this agent's public key as **active** — the
   contract is deployed at
   `CB22R3OJUCQGHZCXH5WAONTURVMSGDIDGIGXA2XQ6UNXDUKYWZKVTER5`.
2. TrusTrove's `submit_attestation` must be deployed; set
   `TRUSTROVE_INVOICE_CONTRACT`.
3. `STELLAR_SUBMITTER_SECRET` must be a testnet-funded account.

Until (2) lands, `submit.ts` runs against a Soroban stub mirroring
`submit_attestation`'s exact signature — which is how its tests run today.

---

## Known limits

These are real, and stated rather than buried:

- **The paid end-to-end flow has not run yet.** The *attestation* half is
  verified against the live contract (see below), but the full
  pay → research → sign → submit → list path has never run, because the x402
  merchant credentials and the CAC API key are not yet provisioned.
- **`submit.ts` has simulated, not sent.** The encoder and signature are
  proven — a real signed payload for an unattested testnet invoice simulates
  successfully through `submit_attestation`, meaning the contract decoded the
  XDR, matched the domain separator and invoice id, recovered the pubkey, and
  found it active in agent-registry. The send path (assemble → sign → poll)
  has not carried a real transaction.
- **The agent registry is admin-curated.** One agent at launch, added by an
  admin key. A disclosed centralisation point, not a solved problem.
- **Cold start.** Platform history has no signal for a brand-new
  buyer/seller pair — scored as unproven, which is honest but not informative.
- **Nigeria only.** CAC is a Nigerian registry. Another market needs another
  legal-existence source.
- **CAC cost is real.** Per-call pricing must track the actual provider fee
  plus margin, not a guessed number (NFR-5).
- **Adverse media is weak evidence here.** Nigerian company news coverage is
  thin; a clean sweep means less than it would elsewhere, which is why web
  research carries the lowest weight and is not a required source.
- **One agent, no consensus.** Multi-agent scoring is post-MVP; the registry
  contract already supports multiple entries but v1 does not exercise it.

---

## Verifying an attestation yourself

Nothing here asks to be taken on trust:

1. Read the attestation off Soroban: `risk_score`, `evidence_hash`, `agent_id`.
2. Fetch the evidence report by that hash.
3. Recompute `hashEvidenceReport(report)` — it must equal `evidence_hash`.
4. Rebuild the XDR payload from the struct above and check the signature recovers
   to a public key that `agent-registry` lists as active.
5. Read `scoreBreakdown` and disagree with the reasoning if you want to. Every
   sub-score carries the reasons that produced it.

Step 5 is the one that matters. The number is not the deliverable; the
evidence is.
