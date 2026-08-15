import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/migrations.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "curio-migrations-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("migrate", () => {
  test("applies each migration once", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "001_create_example.sql"), "CREATE TABLE example (id INTEGER);");
    const database = new Database(":memory:", { strict: true });

    expect(migrate(database, directory)).toBe(1);
    expect(migrate(database, directory)).toBe(0);
    expect(
      database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM schema_migrations").get()
        ?.count,
    ).toBe(1);

    database.close();
  });

  test("rejects changes to an applied migration", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "001_create_example.sql");
    writeFileSync(path, "CREATE TABLE example (id INTEGER);");
    const database = new Database(":memory:", { strict: true });

    migrate(database, directory);
    writeFileSync(path, "CREATE TABLE changed (id INTEGER);");

    expect(() => migrate(database, directory)).toThrow("has been modified");
    database.close();
  });

  test("rolls back a failed migration", () => {
    const directory = temporaryDirectory();
    writeFileSync(
      join(directory, "001_invalid.sql"),
      "CREATE TABLE broken (id INTEGER); INVALID SQL;",
    );
    const database = new Database(":memory:", { strict: true });

    expect(() => migrate(database, directory)).toThrow();
    expect(
      database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM schema_migrations").get()
        ?.count,
    ).toBe(0);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'broken'",
        )
        .get()?.count,
    ).toBe(0);

    database.close();
  });
});
