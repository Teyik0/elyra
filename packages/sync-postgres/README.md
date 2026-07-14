# @teyik0/furin-sync-postgres

Optional PostgreSQL-backed distributed sync adapter for Furin. Apply the bundled migration before starting the application.

```sh
FURIN_SYNC_POSTGRES_URL=postgres://... bunx --package @teyik0/furin-sync-postgres furin-sync-postgres-migrate
```

```ts
import { SQL } from "bun"
import { postgresSyncAdapter } from "@teyik0/furin-sync-postgres"

const adapter = postgresSyncAdapter({
  namespace: "my-app",
  sql: new SQL(databaseUrl),
})
```

This package has no Redis dependency. Without a notifier, Furin polls its durable cursor.
