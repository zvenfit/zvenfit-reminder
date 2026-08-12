import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = resolve(projectRoot, "infra/ydb/migrations");
const ledgerPath = resolve(projectRoot, "infra/ydb/schema-migrations.sql");
const migrationPattern = /^(\d{4})_([a-z0-9_-]+)\.sql$/;

const ledger = await readFile(ledgerPath, "utf8");
if (!/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(ledger)) {
  throw new Error("Migration ledger bootstrap must create schema_migrations idempotently");
}

const filenames = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
if (filenames.length === 0) {
  throw new Error("At least one YDB migration is required");
}

const versions = new Set();
for (const filename of filenames) {
  const match = migrationPattern.exec(filename);
  if (!match) {
    throw new Error(`Invalid YDB migration filename: ${filename}`);
  }

  const version = Number(match[1]);
  if (versions.has(version)) {
    throw new Error(`Duplicate YDB migration version: ${match[1]}`);
  }
  versions.add(version);

  const sql = await readFile(resolve(migrationsDir, filename), "utf8");
  if (!sql.endsWith("\n")) {
    throw new Error(`YDB migration must end with a newline: ${filename}`);
  }
  if (/\b(DROP|TRUNCATE)\b/i.test(sql)) {
    throw new Error(`Destructive DDL is forbidden in normal migrations: ${filename}`);
  }
}

console.log(`Validated ${filenames.length} ordered YDB migration(s).`);
