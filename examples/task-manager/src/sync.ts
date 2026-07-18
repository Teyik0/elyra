import { migrateSqliteSync, sqliteSyncAdapter } from "@teyik0/furin/sync/sqlite";
import { sqlite } from "./db";

migrateSqliteSync(sqlite);

export const taskManagerSync = {
  adapter: sqliteSyncAdapter({ database: sqlite, namespace: "task-manager" }),
  principal: () => "task-manager",
};
