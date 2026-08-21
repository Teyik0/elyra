import { migrateSqliteSync, sqliteSyncAdapter } from "@teyik0/furin/sync/sqlite";
import { sqlite } from "./db";

migrateSqliteSync(sqlite);

const TASK_MANAGER_SYNC_ID = "task-manager";

export const taskManagerSync = {
  adapter: sqliteSyncAdapter({ database: sqlite, namespace: TASK_MANAGER_SYNC_ID }),
  principal: () => TASK_MANAGER_SYNC_ID,
};
