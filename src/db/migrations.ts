import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

interface Migration {
  version: number;
  name: string;
  checksum: string;
  sql: string;
}

interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

const MIGRATION_PATTERN = /^(\d+)_([a-z0-9_-]+)\.sql$/i;

function checksum(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

function readMigrations(directory: string): Migration[] {
  const migrations = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && MIGRATION_PATTERN.test(entry.name))
    .map((entry) => {
      const match = MIGRATION_PATTERN.exec(entry.name);
      if (!match?.[1]) {
        throw new Error(`Invalid migration filename: ${entry.name}`);
      }

      const sql = readFileSync(join(directory, entry.name), "utf8");
      return {
        version: Number(match[1]),
        name: basename(entry.name),
        checksum: checksum(sql),
        sql,
      };
    })
    .sort((left, right) => left.version - right.version);

  const versions = new Set<number>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) {
      throw new Error(`Duplicate migration version: ${migration.version}`);
    }
    versions.add(migration.version);
  }

  return migrations;
}

export function currentSchemaVersion(directory: string): number {
  return readMigrations(directory).at(-1)?.version ?? 0;
}

export function migrationSetIsApplied(database: Database, directory: string): boolean {
  const expected = readMigrations(directory);
  const applied = database
    .query<AppliedMigration, []>(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    )
    .all();

  const expectedByVersion = new Map(expected.map((migration) => [migration.version, migration]));
  const highestExpectedVersion = expected.at(-1)?.version ?? 0;
  const appliedByVersion = new Map(applied.map((migration) => [migration.version, migration]));

  return (
    expected.every((migration) => {
      const row = appliedByVersion.get(migration.version);
      return row?.name === migration.name && row.checksum === migration.checksum;
    }) &&
    applied.every(
      (migration) =>
        migration.version > highestExpectedVersion || expectedByVersion.has(migration.version),
    )
  );
}

export function appliedSchemaVersion(database: Database): number {
  return (
    database
      .query<{ version: number }, []>(
        "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
      )
      .get()?.version ?? 0
  );
}

export function migrate(database: Database, directory: string): number {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = database
    .query<AppliedMigration, []>("SELECT version, name, checksum FROM schema_migrations")
    .all();
  const appliedByVersion = new Map(applied.map((row) => [row.version, row.checksum]));
  const insert = database.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
  );

  let appliedCount = 0;
  for (const migration of readMigrations(directory)) {
    const existingChecksum = appliedByVersion.get(migration.version);
    if (existingChecksum) {
      if (existingChecksum !== migration.checksum) {
        throw new Error(`Applied migration ${migration.name} has been modified`);
      }
      continue;
    }

    const apply = database.transaction(() => {
      database.exec(migration.sql);
      insert.run(migration.version, migration.name, migration.checksum, new Date().toISOString());
    });
    apply();
    appliedCount += 1;
  }

  return appliedCount;
}
