# Contributing to Curio

## Local checks

Run the complete local gate before opening a pull request:

```bash
bun install --frozen-lockfile
bun run check
```

A pull request that changes any non-doc path also adds a verification record,
`verifications/<pr-number>.md`, in the format of `verifications/README.md`.
CI runs `scripts/ci/check-verification-record.sh` on every pull request;
docs-only pull requests (every path `*.md` or under `docs/`) are exempt.

Format files with:

```bash
bun run format
```

For container-level verification:

```bash
bun run smoke:docker
```

Do not commit `.env`, SQLite databases, WAL files, media, backups, tokens, or tunnel credentials.
