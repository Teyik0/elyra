import { type AnyOrama, create, insertMultiple, search as oramaSearch } from "@orama/orama";
import {
  dedupeAndSortHits,
  SEARCH_MIN_QUERY_LENGTH,
  type SearchHit,
  type SearchIndexEntry,
  type SearchResult,
} from "./docs-search-shared";

/**
 * Client-side search runtime. The docs app builds its Orama index on the
 * server (see `docs-search.ts`, which reads markdown from disk) and serves the
 * raw entries as `search-entries.json`. The browser cannot import that server
 * module, so this file owns the client-safe half: rebuilding the index from
 * the fetched entries and running queries against it. Excerpt/dedup/sort
 * logic lives in `docs-search-shared.ts` to stay aligned with the server.
 */

const ORAMA_SCHEMA = {
  content: "string",
  description: "string",
  href: "string",
  kind: "string",
  order: "number",
  section: "string",
  title: "string",
} satisfies Record<string, "string" | "number" | "boolean">;

const RESULT_LIMIT = 8;
const ORAMA_HIT_LIMIT = 16;

export async function createDocsSearchIndex(entries: SearchIndexEntry[]): Promise<AnyOrama> {
  const index = create({ schema: ORAMA_SCHEMA });
  await insertMultiple(index, entries);
  return index;
}

export async function runDocsSearch(index: AnyOrama, rawQuery: string): Promise<SearchResult[]> {
  const term = rawQuery.trim();
  if (term.length < SEARCH_MIN_QUERY_LENGTH) {
    return [];
  }

  const response = await oramaSearch(index, {
    boost: { content: 1, description: 2, section: 3, title: 5 },
    limit: ORAMA_HIT_LIMIT,
    properties: ["title", "section", "description", "content"],
    term,
  });

  return dedupeAndSortHits(response.hits as unknown as SearchHit[], term, RESULT_LIMIT);
}
