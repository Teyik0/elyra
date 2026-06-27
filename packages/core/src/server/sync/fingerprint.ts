interface FingerprintInput {
  body: unknown;
  request: Request;
}

function compareCodePoints(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCodePoints(left, right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

export async function createMutationFingerprint(input: FingerprintInput): Promise<string> {
  const url = new URL(input.request.url);
  const query = [...url.searchParams.entries()].sort(
    ([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey
        ? compareCodePoints(leftValue, rightValue)
        : compareCodePoints(leftKey, rightKey)
  );
  const source = JSON.stringify({
    body: canonicalize(input.body) ?? null,
    contentType: input.request.headers.get("content-type") ?? "",
    method: input.request.method,
    pathname: url.pathname,
    query,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
