import { useCallback } from "react";

export interface SyncMutationHeaders {
  "Idempotency-Key": string;
}

export interface SyncMutationOptions {
  headers: SyncMutationHeaders;
}

export interface SyncMutationContext<TInput> {
  idempotencyKey: string;
  input: TInput;
}

export interface SyncMutationSuccessContext<TInput, TResult> extends SyncMutationContext<TInput> {
  result: TResult;
}

export interface SyncMutationErrorContext<TInput, TResult> extends SyncMutationContext<TInput> {
  error: unknown;
  result?: TResult;
}

export interface UseSyncOptions<TInput, TResult> {
  onError?: (ctx: SyncMutationErrorContext<TInput, TResult>) => Promise<void> | void;
  onSuccess?: (ctx: SyncMutationSuccessContext<TInput, TResult>) => Promise<void> | void;
  optimistic?: (ctx: SyncMutationContext<TInput>) => (() => void) | undefined;
}

export type SyncMutation<TInput, TResult> = (
  input: TInput,
  options: SyncMutationOptions
) => Promise<TResult>;

export type SyncMutationRunner<TInput, TResult> = undefined extends TInput
  ? (input?: TInput) => Promise<TResult>
  : (input: TInput) => Promise<TResult>;

interface EdenErrorResult {
  error?: unknown;
}

function createIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random()}`;
}

function getResolvedError(result: unknown): unknown | undefined {
  if (!(typeof result === "object" && result !== null && "error" in result)) {
    return;
  }

  const error = (result as EdenErrorResult).error;
  return error == null ? undefined : error;
}

export function useSync<TInput, TResult>(
  mutation: SyncMutation<TInput, TResult>,
  options?: UseSyncOptions<TInput, TResult>
): SyncMutationRunner<TInput, TResult> {
  const optimistic = options?.optimistic;
  const onError = options?.onError;
  const onSuccess = options?.onSuccess;

  const run = useCallback(
    async (input: TInput) => {
      const idempotencyKey = createIdempotencyKey();
      const rollback = optimistic?.({ idempotencyKey, input });

      try {
        const result = await mutation(input, {
          headers: { "Idempotency-Key": idempotencyKey },
        });
        const resolvedError = getResolvedError(result);

        if (resolvedError) {
          rollback?.();
          await onError?.({ error: resolvedError, idempotencyKey, input, result });
          return result;
        }

        await onSuccess?.({ idempotencyKey, input, result });
        return result;
      } catch (error) {
        rollback?.();
        await onError?.({ error, idempotencyKey, input });
        throw error;
      }
    },
    [mutation, optimistic, onError, onSuccess]
  );

  return run as SyncMutationRunner<TInput, TResult>;
}
