export function isAbortError(error: unknown): boolean {
  return (
    error !== null && typeof error === "object" && "name" in error && error.name === "AbortError"
  );
}
