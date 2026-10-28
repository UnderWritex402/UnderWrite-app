# Registering an Agent

The MVP registry is admin-managed. Agent operators cannot self-register. The current deployment uses one TrusTrove-operated agent, `underwrite_v1`.

An open registry with public admission and governance is post-MVP work.

## Key roles

Do not confuse these keys:

| Key | Purpose |
| --- | --- |
| `AGENT_EVM_PRIVATE_KEY` | Signs the attestation digest and controls the ERC-8004 identity. |
| Derived 65-byte secp256k1 public key | Stored in the Soroban agent registry. Safe to share. |
| `STELLAR_SUBMITTER_SECRET` | Signs and pays for the Soroban relay transaction. It does not authorize the risk signal. |
| Registry admin key | Authorizes `register_agent` and `revoke_agent`. It is not read by the app. |

Never send the agent private key or registry admin seed to a contributor or place either value in an issue.

## Registration sequence

1. Generate the agent secp256k1 key in an operator-controlled secret store.
2. Set `AGENT_EVM_PRIVATE_KEY` locally.
3. Derive the uncompressed public key:

   ```bash
   node --env-file=.env scripts/print-pubkey.ts
   ```

   Stdout is the `0x04` prefix followed by 64 bytes of coordinates. The script prints the related EVM address to stderr for reference. The registry needs the full public key, not the address.

4. The registry admin calls:

   ```rust
   register_agent(
       admin: Address,
       agent_id: Symbol,
       pubkey: BytesN<65>,
   ) -> ()
   ```

5. Read `get_agent(agent_id)` and compare the returned public key with the locally derived key. Confirm `active` is `true`.
6. Configure the app's `AGENT_ID` with the same Soroban symbol.

## Revocation and replacement

`revoke_agent` keeps the record but sets `active` to `false`. The Invoice contract rejects signatures from an inactive record.

Calling `register_agent` again for the same ID writes the supplied key and sets the record active. The current contract has no separate rotation function or two-step acceptance by the new key. Treat re-registration as a security-sensitive admin action.

## Current deployment

The testnet registry contract is `CB22R3OJUCQGHZCXH5WAONTURVMSGDIDGIGXA2XQ6UNXDUKYWZKVTER5`. A read-only simulation confirmed `underwrite_v1` exists and is active. Do not use the documented deployment scripts against that record unless you intend to change live testnet state.
