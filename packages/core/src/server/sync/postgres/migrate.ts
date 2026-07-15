#!/usr/bin/env bun
import { SQL } from "bun";

const databaseUrl = process.env.FURIN_SYNC_POSTGRES_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("FURIN_SYNC_POSTGRES_URL is required.");
}

const sql = new SQL(databaseUrl);
try {
  const migration = await Bun.file(new URL("./migration.sql", import.meta.url)).text();
  await sql.unsafe(migration);
} finally {
  await sql.close();
}
