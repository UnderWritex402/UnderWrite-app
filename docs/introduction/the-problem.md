# The Problem

Invoice finance depends on the receivable being real, attributable to the stated parties, and supported by evidence a funder can review. A tokenized invoice does not answer those questions by itself.

Nigeria's micro, small, and medium-sized enterprises face a funding gap of about **$160 billion**, according to an African Development Bank analysis reported by Ecofin Agency on 4 December 2024. The figure describes unmet MSME financing demand. It is not an invoice-fraud estimate. [Read the report carried by Making Finance Work for Africa](https://www.mfw4a.org/news/nigerian-small-businesses-face-160bn-funding-gap-afdb-reports).

Underwrite addresses one narrow part of that financing problem: the cost and consistency of checking an invoice before it reaches a financing pool.

## What must be checked

The first-market implementation uses four evidence sources:

| Source | Question | Status |
| --- | --- | --- |
| CAC business-registration lookup | Does the stated counterparty have a matching Nigerian registration record? | Implemented through Dojah, Mono, or Zeeh adapters. |
| TrusTrove on-chain and indexer history | Is the document already attached to another invoice, and how have the parties performed? | Implemented against a configured TrusTrove indexer. |
| Web and news search | Are there relevant fraud, insolvency, regulatory, or litigation findings? | Implemented through Brave, Tavily, or Serper. |
| Invoice document forensics | Does the file show structural edits, suspicious producers, overlays, or date conflicts? | Implemented for PDF structure and common non-PDF signatures. |

These checks do not prove that an invoice will pay. CAC data can be stale, a new buyer can have no platform history, search results can be incomplete, and legitimate PDFs can contain edits. The agent records unavailable evidence and explanations instead of treating missing data as a clean result.

No sourced Nigeria-specific invoice-fraud or unverified-receivable loss figure is used here. The cited $160 billion number must not be presented as one.
