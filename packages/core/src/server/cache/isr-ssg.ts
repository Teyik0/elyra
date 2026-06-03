export interface ISRCacheEntry {
  generatedAt: number;
  html: string;
  revalidate: number;
}

export interface SsgCacheEntry {
  cachedAt: number;
  html: string;
  /**
   * NDJSON payload identical in shape to what the live `/_furin/data` endpoint
   * emits. Persisted alongside the HTML by the static adapter so SPA navigation
   * on a static-hosted deployment can fetch loader data without going through
   * a runtime endpoint that does not exist on a file server.
   */
  ndjson: string;
  status: number;
}
