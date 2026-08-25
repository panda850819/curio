import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

  test("hides legacy X HTML snapshots without deleting them", () => {
    const directory = temporaryDirectory();
    const migrationSource = join(import.meta.dir, "../migrations");
    for (const name of readdirSync(migrationSource).filter((name) => name < "010_")) {
      copyFileSync(join(migrationSource, name), join(directory, name));
    }
    const database = new Database(":memory:", { strict: true });
    migrate(database, directory);
    database.exec(`
      INSERT INTO subscriptions (
        id, adapter, source_key, source_url, enabled, cursor_json, created_at, updated_at, deleted_at
      ) VALUES
        ('x-html', 'html', 'legacy-x', 'https://x.com/YeRuiZhang?s=11', 1, '{"lastHash":"html"}', 1, 1, NULL),
        ('x-html-collision', 'html', 'legacy-existing', 'https://twitter.com/Existing?t=one', 1, NULL, 1, 1, NULL),
        ('x-canonical', 'x', 'existing', 'https://x.com/Existing', 0, NULL, 1, 1, 2),
        ('a-disabled', 'html', 'same-disabled', 'https://x.com/Same?s=11', 0, NULL, 1, 1, NULL),
        ('z-enabled', 'html', 'same-enabled', 'https://twitter.com/same?t=one', 1, NULL, 1, 1, NULL),
        ('x-status', 'html', 'legacy-status', 'https://x.com/legacy/status/1', 1, NULL, 1, 1, NULL),
        ('site-html', 'html', 'site', 'https://example.com/', 1, NULL, 1, 1, NULL);
      INSERT INTO destinations (id, destination_key, kind, created_at, updated_at)
      VALUES ('destination', 'migration-test', 'telegram', 1, 1);
      INSERT INTO routes (
        id, subscription_id, destination_id, enabled, config_json, created_at, updated_at
      ) VALUES
        ('route-rui', 'x-html', 'destination', 1, '{}', 1, 1),
        ('route-existing', 'x-html-collision', 'destination', 1, '{"copied":true}', 1, 1);
      INSERT INTO items (
        id, subscription_id, external_id, discovered_at, created_at, updated_at
      ) VALUES
        ('x-snapshot', 'x-html', 'html:one', 1, 1, 1),
        ('x-collision-snapshot', 'x-html-collision', 'html:collision', 1, 1, 1),
        ('x-status-snapshot', 'x-status', 'html:status', 1, 1, 1),
        ('site-snapshot', 'site-html', 'html:two', 1, 1, 1);
    `);
    copyFileSync(
      join(migrationSource, "010_reader_visibility.sql"),
      join(directory, "010_reader_visibility.sql"),
    );

    expect(migrate(database, directory)).toBe(1);
    expect(
      database
        .query<{ reader_hidden_at: number | null }, [string]>(
          "SELECT reader_hidden_at FROM items WHERE id = ?",
        )
        .get("x-snapshot")?.reader_hidden_at,
    ).toBeNumber();
    expect(
      database
        .query<{ reader_hidden_at: number | null }, [string]>(
          "SELECT reader_hidden_at FROM items WHERE id = ?",
        )
        .get("x-collision-snapshot")?.reader_hidden_at,
    ).toBeNumber();
    expect(
      database
        .query<{ reader_hidden_at: number | null }, [string]>(
          "SELECT reader_hidden_at FROM items WHERE id = ?",
        )
        .get("site-snapshot")?.reader_hidden_at,
    ).toBeNull();
    expect(
      database
        .query<{ reader_hidden_at: number | null }, [string]>(
          "SELECT reader_hidden_at FROM items WHERE id = ?",
        )
        .get("x-status-snapshot")?.reader_hidden_at,
    ).toBeNull();
    expect(
      database
        .query<
          { adapter: string; source_key: string; source_url: string; cursor_json: string | null },
          [string]
        >("SELECT adapter, source_key, source_url, cursor_json FROM subscriptions WHERE id = ?")
        .get("x-html"),
    ).toEqual({
      adapter: "x",
      source_key: "yeruizhang",
      source_url: "https://x.com/yeruizhang",
      cursor_json: null,
    });
    expect(
      database
        .query<{ enabled: number; deleted_at: number | null }, [string]>(
          "SELECT enabled, deleted_at FROM subscriptions WHERE id = ?",
        )
        .get("x-canonical"),
    ).toEqual({ enabled: 1, deleted_at: null });
    expect(
      database
        .query<{ enabled: number; deleted_at: number | null }, [string]>(
          "SELECT enabled, deleted_at FROM subscriptions WHERE id = ?",
        )
        .get("x-html-collision"),
    ).toEqual({ enabled: 0, deleted_at: expect.any(Number) });
    expect(
      database
        .query<{ adapter: string; enabled: number; source_key: string }, [string]>(
          "SELECT adapter, enabled, source_key FROM subscriptions WHERE id = ?",
        )
        .get("a-disabled"),
    ).toEqual({ adapter: "x", enabled: 1, source_key: "same" });
    expect(
      database
        .query<{ enabled: number; deleted_at: number | null }, [string]>(
          "SELECT enabled, deleted_at FROM subscriptions WHERE id = ?",
        )
        .get("z-enabled"),
    ).toEqual({ enabled: 0, deleted_at: expect.any(Number) });
    expect(
      database
        .query<{ config_json: string }, []>(
          "SELECT config_json FROM routes WHERE subscription_id = 'x-canonical' AND destination_id = 'destination'",
        )
        .get()?.config_json,
    ).toBe('{"copied":true}');
    expect(
      database.query<{ count: number }, []>("SELECT count(*) AS count FROM items").get()?.count,
    ).toBe(4);
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
