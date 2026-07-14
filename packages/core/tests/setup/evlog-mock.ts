import { mock } from "bun:test";
import type { AnyElysia } from "elysia";

export interface EvlogMockFields {
  [key: string]: unknown;
}

export type EvlogMockSet = (entry: EvlogMockFields) => void;

const noop = () => undefined;

export const evlogSetMock = mock((_entry: EvlogMockFields) => undefined);

let setHandler: EvlogMockSet = evlogSetMock;

export function setEvlogSetHandler(handler: EvlogMockSet): void {
  setHandler = handler;
}

export function resetEvlogMock(): void {
  setHandler = evlogSetMock;
  evlogSetMock.mockClear();
}

mock.module("evlog/elysia", () => ({
  evlog: () => (app: AnyElysia) =>
    app.derive(() => ({
      log: {
        set: (entry: EvlogMockFields) => setHandler(entry),
      },
    })),
  useLogger: () => ({
    set: (entry: EvlogMockFields) => setHandler(entry),
  }),
}));

mock.module("evlog", () => ({
  createLogger: (ctx: EvlogMockFields = {}) => ({
    emit: noop,
    error: (error: unknown) => {
      ctx.error = error;
    },
    fork: (_label: string, fn: () => unknown) => fn(),
    getContext: () => ctx,
    info: noop,
    set: (entry: EvlogMockFields) => {
      Object.assign(ctx, entry);
    },
    setLevel: noop,
    warn: noop,
  }),
  initLogger: noop,
  log: { debug: noop, error: noop, info: noop, warn: noop },
  useLogger: () => ({
    error: noop,
    info: noop,
    set: (entry: EvlogMockFields) => setHandler(entry),
    warn: noop,
  }),
}));
