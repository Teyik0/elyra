export interface SearchParamsInput {
  [key: string]: unknown;
}

export function appendSearchParamValue(params: URLSearchParams, key: string, value: unknown): void {
  if (value == null) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (item != null) {
        params.append(key, typeof item === "object" ? JSON.stringify(item) : String(item));
      }
    }
    return;
  }

  params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
}

export function buildSearchParams(search: SearchParamsInput): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    appendSearchParamValue(params, key, value);
  }
  return params;
}
