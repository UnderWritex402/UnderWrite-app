# Risk Signal

Underwrite produces a risk signal from `0` to `10000` basis points. Higher is worse. The value is an input to a financing decision, not a credit score or repayment guarantee.

## Source weights

| Source | Weight |
| --- | ---: |
| TrusTrove platform history | 3500 bps, or 35% |
| CAC lookup | 2500 bps, or 25% |
| Document forensics | 2500 bps, or 25% |
| Web research | 1500 bps, or 15% |

All calculations use integers. Each source returns a sub-score from `0` to `10000` and plain-language reasons.

Platform history, CAC lookup, and document forensics are required. If any required source is unavailable, the pipeline returns `insufficient_evidence` and signs nothing. Web research is optional but missing it adds a penalty.

## Missing evidence

The unavailability penalty rate is `3000` bps. Missing web research removes its `1500` bps weight and adds:

```text
1500 × 3000 ÷ 10000 = 450 bps
```

Missing evidence never improves the result.

## Worked example

Assume these source sub-scores:

| Source | Sub-score | Weight | Weighted value |
| --- | ---: | ---: | ---: |
| Platform history | 2000 | 3500 | 7,000,000 |
| CAC lookup | 1000 | 2500 | 2,500,000 |
| Document forensics | 3000 | 2500 | 7,500,000 |
| Web research | unavailable | 1500 | excluded |

Answered weight is `8500`. The weighted average is:

```text
(7,000,000 + 2,500,000 + 7,500,000) ÷ 8500 = 2000 bps
```

Adding the `450` bps missing-web penalty produces a final risk signal of `2450` bps, or 24.50% on the signal's scale.

That percentage does not mean a 24.50% probability of default. It only represents the current rule-based evidence score.

## Interpretation limits

- A new company may have no TrusTrove history.
- CAC and search providers can return stale or incomplete records.
- PDF edits can be legitimate.
- A low signal does not prove the buyer will pay.
- A high signal should lead to review, not an automatic allegation of fraud.
