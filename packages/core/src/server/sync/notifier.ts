import type { SyncAdapter, SyncNotifier, SyncSubscription } from "./adapter.ts";

export class MemorySyncNotifier implements SyncNotifier {
  private readonly listeners = new Set<(cursor: string) => void>();

  publish(cursor: string): Promise<void> {
    for (const listener of [...this.listeners]) {
      listener(cursor);
    }
    return Promise.resolve();
  }

  subscribe(listener: (cursor: string) => void): Promise<SyncSubscription> {
    this.listeners.add(listener);
    return Promise.resolve({
      unsubscribe: () => {
        this.listeners.delete(listener);
        return Promise.resolve();
      },
    });
  }

  reset(): void {
    this.listeners.clear();
  }
}

export class PollingSyncNotifier implements SyncNotifier {
  private readonly adapter: SyncAdapter;
  private readonly intervalMs: number;
  private readonly listeners = new Set<(cursor: string) => void>();
  private cursor: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(adapter: SyncAdapter, intervalMs: number) {
    this.adapter = adapter;
    this.intervalMs = intervalMs;
  }

  publish(cursor: string): Promise<void> {
    this.emit(cursor);
    return Promise.resolve();
  }

  async subscribe(listener: (cursor: string) => void): Promise<SyncSubscription> {
    this.listeners.add(listener);
    if (!this.timer) {
      this.cursor = await this.adapter.currentCursor();
      this.timer = setInterval(() => {
        this.poll().catch(() => undefined);
      }, this.intervalMs);
    }
    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
        if (this.listeners.size === 0 && this.timer) {
          clearInterval(this.timer);
          this.timer = undefined;
        }
        return Promise.resolve();
      },
    };
  }

  private emit(cursor: string): void {
    if (cursor === this.cursor) {
      return;
    }
    this.cursor = cursor;
    for (const listener of [...this.listeners]) {
      listener(cursor);
    }
  }

  private async poll(): Promise<void> {
    this.emit(await this.adapter.currentCursor());
  }
}

export const memorySyncNotifier = new MemorySyncNotifier();
