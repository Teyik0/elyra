import type {
  AbortMutationInput,
  AppendChangesInput,
  AppendChangesResult,
  BeginMutationInput,
  BeginMutationResult,
  ChangePage,
  CommitMutationInput,
  ReadChangesInput,
  StoredResponse,
  SyncAdapter,
  SyncChange,
  SyncChangeListener,
} from "./adapter.ts";

const MAX_CHANGES = 1000;
const MAX_MUTATIONS = 10_000;
const MUTATION_EVICTION_INTERVAL_MS = 60 * 1000;
const MUTATION_TTL_MS = 24 * 60 * 60 * 1000;

interface PendingMutation {
  createdAt: number;
  fingerprint: string;
  mutationId: string;
  state: "in-progress";
}

interface CompletedMutation {
  createdAt: number;
  fingerprint: string;
  mutationId: string;
  response: StoredResponse;
  state: "succeeded";
}

type MutationEntry = CompletedMutation | PendingMutation;

interface ChangeState {
  changes: SyncChange[];
  listeners: Set<SyncChangeListener>;
  nextCursor: number;
}

export class MemorySyncAdapter implements SyncAdapter {
  private readonly changes = new Map<string, ChangeState>();
  private readonly mutationKeys = new Map<string, string>();
  private readonly mutations = new Map<string, MutationEntry>();
  private lastMutationEvictionAt = 0;

  beginMutation(input: BeginMutationInput): BeginMutationResult {
    const now = Date.now();
    const mutationKey = `${input.principal}:${input.key}`;
    const existingId = this.mutationKeys.get(mutationKey);
    const existing = existingId ? this.mutations.get(existingId) : undefined;
    if (existing) {
      if (this.isExpired(existing, now)) {
        this.deleteMutation(existing.mutationId);
      } else {
        if (existing.fingerprint !== input.fingerprint) {
          return { kind: "conflict", reason: "payload-mismatch" };
        }
        if (existing.state === "in-progress") {
          return { kind: "conflict", reason: "in-progress" };
        }
        return { kind: "replay", response: existing.response };
      }
    }
    if (this.shouldEvictMutations(now)) {
      this.evictMutations(now);
    }
    if (this.mutations.size >= MAX_MUTATIONS) {
      return { kind: "unavailable" };
    }

    const mutationId = crypto.randomUUID();
    this.mutationKeys.set(mutationKey, mutationId);
    this.mutations.set(mutationId, {
      createdAt: now,
      fingerprint: input.fingerprint,
      mutationId,
      state: "in-progress",
    });
    return { kind: "execute", mutationId };
  }

  commitMutation(input: CommitMutationInput): void {
    const existing = this.mutations.get(input.mutationId);
    if (!existing) {
      return;
    }
    this.mutations.set(input.mutationId, {
      ...existing,
      response: input.response,
      state: "succeeded",
    });
  }

  abortMutation(input: AbortMutationInput): void {
    const existing = this.mutations.get(input.mutationId);
    if (!existing) {
      return;
    }
    this.mutations.delete(input.mutationId);
    for (const [key, mutationId] of this.mutationKeys) {
      if (mutationId === input.mutationId) {
        this.mutationKeys.delete(key);
        break;
      }
    }
  }

  appendChanges(input: AppendChangesInput): AppendChangesResult {
    const state = this.getChangeState(input.path);
    const change: SyncChange = {
      cursor: String(state.nextCursor),
      invalidations: [...input.invalidations],
    };
    state.nextCursor += 1;
    state.changes.push(change);
    if (state.changes.length > MAX_CHANGES) {
      state.changes.shift();
    }
    for (const listener of [...state.listeners]) {
      listener(change);
    }
    return { change };
  }

  readChanges(input: ReadChangesInput): ChangePage {
    const state = this.getChangeState(input.path);
    const currentCursor = String(state.nextCursor - 1);
    if (input.after === undefined) {
      return { changes: [], cursor: currentCursor, hasMore: false, reset: false };
    }

    const after = Number.parseInt(input.after, 10);
    const oldest = Number.parseInt(state.changes[0]?.cursor ?? currentCursor, 10);
    if (after < oldest - 1) {
      return {
        changes: [{ cursor: currentCursor, invalidations: ["/:layout"] }],
        cursor: currentCursor,
        hasMore: false,
        reset: true,
      };
    }
    const available = state.changes.filter((change) => Number.parseInt(change.cursor, 10) > after);
    const changes = available.slice(0, input.limit);
    return {
      changes,
      cursor: changes.at(-1)?.cursor ?? input.after,
      hasMore: available.length > changes.length,
      reset: false,
    };
  }

  subscribe(path: string, listener: SyncChangeListener): () => void {
    const { listeners } = this.getChangeState(path);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  reset(): void {
    this.changes.clear();
    this.mutationKeys.clear();
    this.mutations.clear();
  }

  private evictMutations(now: number): void {
    this.lastMutationEvictionAt = now;
    const expiredBefore = now - MUTATION_TTL_MS;
    for (const [mutationId, mutation] of this.mutations) {
      if (mutation.createdAt < expiredBefore) {
        this.deleteMutation(mutationId);
      }
    }
    if (this.mutations.size < MAX_MUTATIONS) {
      return;
    }
    for (const mutation of this.mutations.values()) {
      if (mutation.state === "succeeded") {
        this.deleteMutation(mutation.mutationId);
        if (this.mutations.size < MAX_MUTATIONS) {
          return;
        }
      }
    }
  }

  private isExpired(mutation: MutationEntry, now: number): boolean {
    return mutation.createdAt < now - MUTATION_TTL_MS;
  }

  private shouldEvictMutations(now: number): boolean {
    return (
      this.mutations.size >= MAX_MUTATIONS ||
      now - this.lastMutationEvictionAt >= MUTATION_EVICTION_INTERVAL_MS
    );
  }

  private deleteMutation(mutationId: string): void {
    this.mutations.delete(mutationId);
    for (const [key, storedId] of this.mutationKeys) {
      if (storedId === mutationId) {
        this.mutationKeys.delete(key);
        return;
      }
    }
  }

  private getChangeState(path: string): ChangeState {
    const existing = this.changes.get(path);
    if (existing) {
      return existing;
    }
    const state: ChangeState = { changes: [], listeners: new Set(), nextCursor: 1 };
    this.changes.set(path, state);
    return state;
  }
}

export const memorySyncAdapter = new MemorySyncAdapter();
