# Attestation Format

The `payload` sent to TrusTrove is the Soroban XDR encoding of this Rust contract type:

```rust
pub struct AttestationPayload {
    pub domain_separator: BytesN<32>,
    pub invoice_id: BytesN<32>,
    pub risk_score: u32,
    pub evidence_hash: BytesN<32>,
    pub agent_id: Symbol,
    pub nonce: u64,
}
```

Soroban encodes the struct as an `ScVal::Map`. The symbol keys are ordered lexicographically on the wire:

1. `agent_id`
2. `domain_separator`
3. `evidence_hash`
4. `invoice_id`
5. `nonce`
6. `risk_score`

## Field rules

| Field | Rule |
| --- | --- |
| `domain_separator` | Exactly the 32 ASCII bytes `TrusTrove.InvoiceAttestation.v1_`. |
| `invoice_id` | Exactly 32 raw bytes as `ScVal::Bytes`. It is never a number or string in XDR. |
| `risk_score` | Unsigned 32-bit integer from `0` to `10000`. |
| `evidence_hash` | Exactly 32 bytes: Keccak-256 of the canonical evidence report. |
| `agent_id` | Soroban `Symbol`, 1–32 characters from `[a-zA-Z0-9_]`. |
| `nonce` | Unsigned 64-bit integer derived deterministically by the app. |

For example, a 12.50% risk signal is encoded as `risk_score = 1250`, not `12.5`.

## Signature

The signed digest is:

```text
keccak256(xdr_payload_bytes)
```

The signature is 65 bytes:

```text
r[32] || s[32] || recovery_id[1]
```

`recovery_id` is `0` or `1`. The Invoice contract splits the last byte, recovers the uncompressed secp256k1 public key, and compares it with the 65-byte key returned by `get_agent`.

## Contract checks

`submit_attestation(invoice_id, payload, signature)` checks:

- The invoice exists and has no prior attestation.
- The payload decodes as `AttestationPayload`.
- The domain separator is exact.
- The payload invoice ID matches the function argument.
- The recovered key belongs to an active registry agent.

The app rejects 0-, 31-, and 33-byte invoice IDs. Tests also decode the XDR back to raw bytes, verify the pinned base64 representation, and confirm that changing any one of the 32 invoice ID bytes changes the digest.
