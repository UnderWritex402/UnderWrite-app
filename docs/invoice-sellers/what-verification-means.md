# What Verification Means For Your Listing

Underwrite checks evidence connected to an invoice before TrusTrove allows that invoice to enter the financing market.

## Information used

The current agent uses:

- The invoice file and its printed dates.
- Buyer and seller names, Stellar addresses, and supplied CAC registration numbers.
- TrusTrove history for those addresses and the document hash.
- Public web and news search results.
- PDF structure and metadata.

The full report is stored off-chain. The on-chain attestation contains the risk signal, evidence hash, agent ID, and submission time.

## Possible outcomes

### Attested

The required sources answered, the agent calculated a risk signal, and it signed an attestation. The Invoice contract must still accept that signature before the listing gate opens.

### Insufficient evidence

At least one required source was unavailable. Required sources are platform history, CAC lookup, and document forensics. The agent stores a report explaining the gap but does not produce a score or signature.

### Contract rejection

The payload can be rejected when the invoice does not exist, already has an attestation, uses a mismatched invoice ID or domain, or is signed by a missing, inactive, or different registry key.

## What verification does not mean

- It does not approve financing.
- It does not promise repayment.
- It does not prove that every statement on an invoice is true.
- It is not a credit score.
- It does not replace the financing pool's own terms and limits.

## Example

An invoice receives a risk signal of `2450` bps and an evidence hash beginning with `0x8a…`. The number records the current scoring result. A reviewer should retrieve the matching evidence report, recompute its full hash, inspect the source explanations, and then decide how much weight to give the signal.
