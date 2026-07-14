# @teyik0/furin-sync-redis

Optional durable Redis adapter and best-effort Redis notifier for Furin sync.
The package uses Bun's native `RedisClient`; it has no PostgreSQL dependency.

```ts
import { RedisClient } from "bun"
import { redisSyncAdapter, redisSyncNotifier } from "@teyik0/furin-sync-redis"

const redisUrl = process.env.FURIN_SYNC_REDIS_URL
const client = new RedisClient(redisUrl)
const adapter = redisSyncAdapter({ client, namespace: "my-app" })
const notifier = redisSyncNotifier({ client, namespace: "my-app" })
```

Import `redisSyncNotifier` alone when PostgreSQL remains the durable adapter. Tree-shaking removes the Redis storage scripts from that hybrid bundle.
