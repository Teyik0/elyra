interface FingerprintInput {
  body: unknown;
  request: Request;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

export async function createMutationFingerprint(input: FingerprintInput): Promise<string> {
  const url = new URL(input.request.url);
  const query = [...url.searchParams.entries()].sort(
    ([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey)
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
