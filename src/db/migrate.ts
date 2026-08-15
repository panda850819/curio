import { resolve } from "node:path";
import { loadConfig } from "../config.ts";
import { openDatabase } from "./database.ts";
import { migrate } from "./migrations.ts";

const config = loadConfig();
const database = openDatabase(config.databasePath);
const migrationsPath = process.env.MIGRATIONS_PATH || resolve(import.meta.dir, "../../migrations");

try {
  const appliedMigrations = migrate(database, migrationsPath);
  console.log(JSON.stringify({ status: "ok", appliedMigrations }));
} finally {
  database.close();
}
