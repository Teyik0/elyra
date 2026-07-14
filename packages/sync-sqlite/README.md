# @teyik0/furin-sync-sqlite

Host-local durable sync adapter for Furin using Bun's native `bun:sqlite` driver.

```ts
import { Database } from "bun:sqlite"
import { migrateSqliteSync, sqliteSyncAdapter } from "@teyik0/furin-sync-sqlite"

const database = new Database("app.db", { create: true })
database.run("PRAGMA journal_mode = WAL")
database.run("PRAGMA busy_timeout = 5000")
migrateSqliteSync(database)

const sync = {
  adapter: sqliteSyncAdapter({ database, namespace: "my-app" }),
}
```

Pass the same `sync` object to `furinSync(sync)` and `furin({ sync })`. The migration is also available at `@teyik0/furin-sync-sqlite/migration.sql` for applications that manage schema changes separately.

SQLite persists mutation leases, replay responses, cursors, and invalidations atomically in the same file. Its `host-local` scope supports restarts and multiple Bun processes sharing that file on one host. It is not a multi-host adapter and should not be placed on a network filesystem. Use PostgreSQL or Redis when replicas run on separate hosts.

Without a notifier, Furin polls the SQLite cursor. This package has no PostgreSQL or Redis dependency and declares `sideEffects: false`.
