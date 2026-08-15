# Contributing to Curio

## Local checks

Run the complete local gate before opening a pull request:

```bash
bun install --frozen-lockfile
bun run check
```

Format files with:

```bash
bun run format
```

For container-level verification:

```bash
bun run smoke:docker
```

Do not commit `.env`, SQLite databases, WAL files, media, backups, tokens, or tunnel credentials.
