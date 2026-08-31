import type { Database } from "bun:sqlite";
import {
  appliedSchemaVersion,
  currentSchemaVersion,
  migrationSetIsApplied,
} from "./db/migrations.ts";

export const SERVICE_NAME = "curio";

export interface BuildInfo {
  revision: string;
  buildTime: string;
  schemaVersion: number;
}

export type ReadinessCheckStatus = "ok" | "error" | "not_checked";

export interface ReadinessResult {
  status: "ok" | "error";
  service: typeof SERVICE_NAME;
  checks: {
    database: ReadinessCheckStatus;
    migrations: ReadinessCheckStatus;
  };
  schemaVersion: number;
}

export function buildInfoFromEnvironment(schemaVersion: number): BuildInfo {
  return {
    revision: process.env.CURIO_RELEASE_REVISION?.trim() || "unknown",
    buildTime: process.env.CURIO_BUILD_TIME?.trim() || "unknown",
    schemaVersion,
  };
}

export function checkReadiness(database: Database, migrationsPath: string): ReadinessResult {
  let databaseStatus: ReadinessCheckStatus = "error";
  let migrationsStatus: ReadinessCheckStatus = "not_checked";
  let schemaVersion = 0;

  try {
    database.query<{ value: number }, []>("SELECT 1 AS value").get();
    databaseStatus = "ok";
  } catch {
    return {
      status: "error",
      service: SERVICE_NAME,
      checks: { database: databaseStatus, migrations: migrationsStatus },
      schemaVersion,
    };
  }

  try {
    schemaVersion = appliedSchemaVersion(database);
    migrationsStatus = migrationSetIsApplied(database, migrationsPath) ? "ok" : "error";
  } catch {
    migrationsStatus = "error";
  }

  return {
    status: databaseStatus === "ok" && migrationsStatus === "ok" ? "ok" : "error",
    service: SERVICE_NAME,
    checks: { database: databaseStatus, migrations: migrationsStatus },
    schemaVersion,
  };
}

export function schemaVersionForBuild(migrationsPath: string): number {
  return currentSchemaVersion(migrationsPath);
}
