# Environment Variables

Use names only in documentation and logs. Store values outside the repository.

## Agent identity

| Name | Required | Purpose | Source |
| --- | --- | --- | --- |
| `AGENT_EVM_PRIVATE_KEY` | Yes for signing and ERC-8004 calls | secp256k1 signing key | Operator secret store |
| `AGENT_ID` | Yes for signing | Soroban symbol written into the payload | Agent registry configuration |
| `ERC8004_AGENT_ID` | No | Existing numeric ERC-8004 identity | Identity registration result |
| `AGENT_REGISTRATION_URI` | Required only for first ERC-8004 registration | Durable registration document URL | Operator-hosted HTTPS or IPFS document |

## Stellar submission

| Name | Required | Purpose | Source |
| --- | --- | --- | --- |
| `STELLAR_RPC_URL` | Yes | Soroban RPC endpoint | Stellar network provider |
| `STELLAR_NETWORK_PASSPHRASE` | Yes | Transaction network passphrase | Stellar network configuration |
| `STELLAR_SUBMITTER_SECRET` | Yes | Pays and signs relay transactions | Funded testnet account secret |
| `TRUSTROVE_INVOICE_CONTRACT` | Yes | Target for `submit_attestation` | TrusTrove deployment |
| `AGENT_REGISTRY_CONTRACT` | Needed for registry preflight, but not yet parsed by `config.ts` | Target for `get_agent` | Underwrite registry deployment |

## TrusTrove history

| Name | Required | Purpose | Source |
| --- | --- | --- | --- |
| `TRUSTROVE_INDEXER_URL` | Yes | Base URL for history and duplicate checks | TrusTrove indexer deployment |
| `TRUSTROVE_INDEXER_API_KEY` | No | Bearer credential when the indexer requires one | TrusTrove operator |

## CAC lookup

| Name | Required | Purpose | Source |
| --- | --- | --- | --- |
| `CAC_LOOKUP_PROVIDER` | Yes | Selects `dojah`, `mono`, or `zeeh` | Operator choice |
| `CAC_LOOKUP_BASE_URL` | Yes | Provider API base URL | Provider documentation |
| `CAC_LOOKUP_API_KEY` | Yes | Provider credential | Provider dashboard |
| `CAC_LOOKUP_APP_ID` | Provider-dependent | Extra application identifier used by Dojah | Provider dashboard |

## Web research

| Name | Required | Purpose | Source |
| --- | --- | --- | --- |
| `WEB_SEARCH_PROVIDER` | Yes | Selects `brave`, `tavily`, or `serper` | Operator choice |
| `WEB_SEARCH_API_KEY` | Yes | Search credential | Provider dashboard |
| `WEB_SEARCH_MAX_RESULTS` | No; default `10` | Per-query result limit from `1` to `20` | Operator configuration |

## Payment and GOAT runtime

| Name | Required | Purpose | Source |
| --- | --- | --- | --- |
| `MERCHANT_PORTAL_BASE_URL` | Yes for payment checks | x402 merchant portal endpoint | Merchant portal deployment |
| `MERCHANT_PORTAL_EMAIL` | Yes for payment checks | Merchant login identifier | Merchant account |
| `MERCHANT_PORTAL_PASSWORD` | Yes for payment checks | Merchant login secret | Merchant account secret store |
| `GOAT_NETWORK` | No; default `goat-testnet` | GOAT network selection | GOAT Network configuration |
| `GOAT_RPC_URL` | No | Optional GOAT RPC override | RPC provider |
| `AGENTKIT_IDEMPOTENCY_MODE` | No; consumed by AgentKit | Selects AgentKit's idempotency store | Deployment configuration |

## Evidence storage

| Name | Required | Purpose | Source |
| --- | --- | --- | --- |
| `EVIDENCE_STORE_DIR` | No; default `./.evidence` | Filesystem root for canonical reports | Local deployment configuration |

## Validation notes

`config.ts` validates each subsystem only when that subsystem is used. It validates formats for EVM keys, Stellar seeds, contract IDs, URLs, provider choices, and the Soroban agent symbol.

`AGENTKIT_IDEMPOTENCY_MODE` is read inside `createIdempotencyStoreFromEnv`, not the app's Zod schemas. `AGENT_REGISTRY_CONTRACT` appears in `.env.example` but has no current app schema or registry client; that gap is tracked in the issue list.
