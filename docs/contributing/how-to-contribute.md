# How to Contribute

Read the repository's [CONTRIBUTING.md](../../CONTRIBUTING.md) before starting.

## Pick work

Choose an open issue that is not assigned and has no unmet `Depends on` section. Comment on the issue before writing code.

Issue labels describe the expected area and size:

- `complexity:low`, `complexity:medium`, or `complexity:high`.
- An area such as `area:attestation`, `area:soroban-client`, or `area:verification`.
- `Stellar Wave` for the Wave backlog.

## Branch and commit

Branch from `main` using one of these forms:

```text
feat/123-short-name
fix/123-short-name
docs/123-short-name
test/123-short-name
```

Use Conventional Commits:

```text
feat(cli): add transaction status command
fix(attestation): reject malformed invoice id
test(submit): cover failed confirmation
```

Commit and push each completed change before starting the next change.

## Verify

Run:

```bash
npm run typecheck
npm test
npm run build
```

Behavior changes need tests. Environment changes need updates to `.env.example`, the README table, and the environment reference.

## Pull request checklist

- [ ] The PR links the issue.
- [ ] Scope matches the issue and no unrelated files changed.
- [ ] Typecheck, tests, and build pass.
- [ ] New behavior has failure-path coverage.
- [ ] Public functions and configuration are documented.
- [ ] No `.env`, private key, seed, API key, password, or bearer token is included.
- [ ] Stellar-facing changes explain testnet behavior and contract assumptions.

## Security reports

Do not open a public issue for a vulnerability. Follow [SECURITY.md](../../SECURITY.md). GitHub private vulnerability reporting still needs to be enabled by the repository owner before that channel is usable.
