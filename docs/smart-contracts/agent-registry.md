# Agent Registry

The Underwrite agent registry is a Soroban contract written in Rust 2021 with `soroban-sdk` 27.0.6.

It stores:

```rust
pub struct AgentInfo {
    pub pubkey: BytesN<65>,
    pub active: bool,
}
```

The public key is the uncompressed secp256k1 key used by the Invoice contract during signature recovery.

## `initialize`

```rust
initialize(admin: Address) -> ()
```

- Auth: none in the current contract.
- Writes: stores `admin` in instance storage.
- Panics: `AlreadyInitialized` when an admin is already stored.

Because initialization does not call `admin.require_auth()`, deployment and initialization should not be treated as safely separable on an untrusted network. Requiring initialization authorization is tracked as a security issue.

## `register_agent`

```rust
register_agent(
    admin: Address,
    agent_id: Symbol,
    pubkey: BytesN<65>,
) -> ()
```

- Auth: `admin.require_auth()` and equality with the stored admin.
- Writes: stores or replaces `AgentInfo { pubkey, active: true }` in persistent storage.
- TTL: extends the agent entry when written.
- Event: `AgentRegistered` with the agent ID topic and public-key data.
- Panics: `NotInitialized` when no admin is stored; `Unauthorized` when the address is not the stored admin.

Calling this function for a revoked ID reactivates it. Calling it for an active ID can replace its key. Those behaviors need explicit operational controls.

## `revoke_agent`

```rust
revoke_agent(admin: Address, agent_id: Symbol) -> ()
```

- Auth: `admin.require_auth()` and equality with the stored admin.
- Writes: keeps the record and sets `active` to `false`.
- TTL: extends the agent entry when written.
- Event: `AgentRevoked` with the agent ID topic.
- Panics: `NotInitialized` when the admin or target agent record is missing; `Unauthorized` for the wrong admin.

The shared `NotInitialized` error does not distinguish a missing agent from a missing contract admin.

## `get_agent`

```rust
get_agent(agent_id: Symbol) -> Option<AgentInfo>
```

- Auth: none.
- Returns: the stored record or `None`.
- Writes: none.
- Panics: none in the function body.

Reads do not extend the persistent entry's TTL. Long-lived records must be maintained before expiry.

## MVP administration

The MVP uses one admin-registered agent, `underwrite_v1`. A read-only testnet simulation confirmed that this record exists and is active at the documented registry address. Admin rotation and open agent admission are not implemented.
