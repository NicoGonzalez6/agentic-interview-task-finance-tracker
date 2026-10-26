import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { runMigrations } from "#/db/migrate";
import { checkReadiness } from "#/server/health.server";

const migrationsFolder = join(process.cwd(), "drizzle");

async function migratedDb() {
  const db = drizzle(new PGlite());
  await runMigrations(db, "pglite", migrationsFolder);
  return db;
}

// Booting a fresh PGlite and replaying every migration can exceed the 5s
// default when the whole suite runs in parallel.
describe("readiness check", { timeout: 20_000 }, () => {
  it("reports ready against a reachable, migrated database", async () => {
    const db = await migratedDb();
    const result = await checkReadiness(db, migrationsFolder);
    expect(result).toEqual({
      ready: true,
      checks: { database: "ok", migrations: "ok" },
    });
  });

  it("reports not ready when the schema is behind the journal", async () => {
    const db = await migratedDb();
    await db.execute(
      sql`DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)`,
    );
    const result = await checkReadiness(db, migrationsFolder);
    expect(result.ready).toBe(false);
    expect(result.checks).toEqual({ database: "ok", migrations: "error" });
  });

  it("reports not ready when the database query fails", async () => {
    const broken = {
      execute: () => Promise.reject(new Error("connection refused")),
    } as unknown as Parameters<typeof checkReadiness>[0];
    const result = await checkReadiness(broken, migrationsFolder);
    expect(result.ready).toBe(false);
    expect(result.checks.database).toBe("error");
  });
});
