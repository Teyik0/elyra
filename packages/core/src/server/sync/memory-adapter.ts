import type {
  BeginMutationInput,
  BeginMutationResult,
  ChangePage,
  CompleteMutationInput,
  CompleteMutationResult,
  MutationLease,
  ReadChangesInput,
  StoredResponse,
  SyncAdapter,
  SyncChange,
} from "./adapter.ts";

const MAX_CHANGES = 1000;
const MAX_MUTATIONS = 10_000;
const MUTATION_LEASE_MS = 30_000;
const MUTATION_TTL_MS = 24 * 60 * 60 * 1000;

interface PendingMutation {
  fingerprint: string;
  lease: MutationLease;
  leaseExpiresAt: number;
  state: "in-progress";
}

interface CompletedMutation {
  expiresAt: number;
  fingerprint: string;
  response: StoredResponse;
  state: "succeeded";
}

type MutationEntry = CompletedMutation | PendingMutation;

function mutationKey(input: Pick<MutationLease, "key" | "principal">): string {
  return `${input.principal.length}:${input.principal}${input.key}`;
}

export class MemorySyncAdapter implements SyncAdapter {
  readonly scope = "process-local" as const;
  private readonly changes: SyncChange[] = [];
  private readonly mutations = new Map<string, MutationEntry>();
  private nextCursor = 1;

  beginMutation(input: BeginMutationInput): Promise<BeginMutationResult> {
    const now = Date.now();
    const key = mutationKey(input);
    const existing = this.mutations.get(key);
    if (existing) {
      const expired =
        existing.state === "in-progress"
          ? existing.leaseExpiresAt <= now
          : existing.expiresAt <= now;
      if (expired) {
        this.mutations.delete(key);
      } else if (existing.fingerprint !== input.fingerprint) {
        return Promise.resolve({ kind: "conflict", reason: "payload-mismatch" });
      } else if (existing.state === "in-progress") {
        return Promise.resolve({ kind: "conflict", reason: "in-progress" });
      } else {
        return Promise.resolve({ kind: "replay", response: existing.response });
      }
    }

    this.evictExpired(now);
    if (this.mutations.size >= MAX_MUTATIONS) {
      return Promise.resolve({ kind: "unavailable" });
    }
    const lease: MutationLease = {
      id: crypto.randomUUID(),
      key: input.key,
      leaseMs: MUTATION_LEASE_MS,
      principal: input.principal,
    };
    this.mutations.set(key, {
      fingerprint: input.fingerprint,
      lease,
      leaseExpiresAt: now + lease.leaseMs,
      state: "in-progress",
    });
    return Promise.resolve({ kind: "execute", lease });
  }

  renewMutation(lease: MutationLease): Promise<"lost" | "renewed"> {
    const entry = this.mutations.get(mutationKey(lease));
    if (
      entry?.state !== "in-progress" ||
      entry.lease.id !== lease.id ||
      entry.leaseExpiresAt <= Date.now()
    ) {
      return Promise.resolve("lost");
    }
    entry.leaseExpiresAt = Date.now() + lease.leaseMs;
    return Promise.resolve("renewed");
  }

  completeMutation(input: CompleteMutationInput): Promise<CompleteMutationResult> {
    const key = mutationKey(input.lease);
    const entry = this.mutations.get(key);
    if (
      entry?.state !== "in-progress" ||
      entry.lease.id !== input.lease.id ||
      entry.leaseExpiresAt <= Date.now()
    ) {
      return Promise.resolve({ kind: "lost" });
    }
    this.mutations.set(key, {
      expiresAt: Date.now() + MUTATION_TTL_MS,
      fingerprint: entry.fingerprint,
      response: input.response,
      state: "succeeded",
    });
    if (input.invalidations.length === 0) {
      return Promise.resolve({ cursor: undefined, kind: "committed" });
    }
    const change: SyncChange = {
      cursor: String(this.nextCursor),
      invalidations: input.invalidations,
    };
    this.nextCursor += 1;
    this.changes.push(change);
    if (this.changes.length > MAX_CHANGES) {
      this.changes.shift();
    }
    return Promise.resolve({ cursor: change.cursor, kind: "committed" });
  }

  abortMutation(lease: MutationLease): Promise<void> {
    const key = mutationKey(lease);
    const entry = this.mutations.get(key);
    if (entry?.state === "in-progress" && entry.lease.id === lease.id) {
      this.mutations.delete(key);
    }
    return Promise.resolve();
  }

  currentCursor(): Promise<string> {
    return Promise.resolve(String(this.nextCursor - 1));
  }

  async readChanges(input: ReadChangesInput): Promise<ChangePage> {
    const cursor = await this.currentCursor();
    if (input.after === undefined) {
      return { changes: [], cursor, hasMore: false, reset: false };
    }
    const after = Number.parseInt(input.after, 10);
    const oldest = Number.parseInt(this.changes[0]?.cursor ?? cursor, 10);
    if (!Number.isSafeInteger(after) || after < oldest - 1 || after > Number(cursor)) {
      return { changes: [], cursor, hasMore: false, reset: true };
    }
    const available = this.changes.filter((change) => Number.parseInt(change.cursor, 10) > after);
    const changes = available.slice(0, input.limit);
    return {
      changes,
      cursor: changes.at(-1)?.cursor ?? input.after,
      hasMore: available.length > changes.length,
      reset: false,
    };
  }

  reset(): void {
    this.changes.length = 0;
    this.mutations.clear();
    this.nextCursor = 1;
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.mutations) {
      if (
        (entry.state === "in-progress" && entry.leaseExpiresAt <= now) ||
        (entry.state === "succeeded" && entry.expiresAt <= now)
      ) {
        this.mutations.delete(key);
      }
    }
  }
}

export const memorySyncAdapter = new MemorySyncAdapter();
