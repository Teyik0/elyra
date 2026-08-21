export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}
