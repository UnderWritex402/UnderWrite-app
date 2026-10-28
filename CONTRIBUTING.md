# Contributing

## Pick an issue

Choose an open issue that is not assigned. Comment on it before starting. Do not work on an issue that lists an unmet dependency.

## Create a branch

Branch from `main` and use one of these forms:

- `feat/<issue-number>-short-name`
- `fix/<issue-number>-short-name`
- `docs/<issue-number>-short-name`
- `test/<issue-number>-short-name`

## Make the change

- Keep the change within the issue scope.
- Add or update tests when behavior changes.
- Run `npm run typecheck`, `npm test`, and `npm run build`.
- Use Conventional Commits, such as `fix(attestation): reject invalid invoice id`.

## Pull request checklist

- [ ] The PR links its issue.
- [ ] The branch is up to date with `main`.
- [ ] Typecheck, tests, and build pass.
- [ ] Tests cover behavior changes.
- [ ] Public behavior and environment variables are documented.
- [ ] No secret, seed, private key, API key, bearer token, or `.env` file is committed.
