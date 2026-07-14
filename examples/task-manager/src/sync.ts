import { migrateSqliteSync, sqliteSyncAdapter } from "@teyik0/furin-sync-sqlite";
import { sqlite } from "./db";

migrateSqliteSync(sqlite);

const namespace =
  process.env.FURIN_SYNC_NAMESPACE ??
  (process.env.NODE_ENV === "test" ? `task-manager-test-${process.pid}` : "task-manager");

export const taskManagerSync = {
  adapter: sqliteSyncAdapter({ database: sqlite, namespace }),
};
