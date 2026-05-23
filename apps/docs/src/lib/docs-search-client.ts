import { type AnyOrama, create, insertMultiple, search as oramaSearch } from "@orama/orama";
import type { SearchIndexEntry } from "@/lib/docs-search";

/**
 * Client-side search runtime. The docs app builds its Orama index on the
 * server (see `docs-search.ts`, which reads markdown from disk) and serves the
 * raw entries as `search-entries.json`. The browser cannot import that server
 * module, so this file owns the client-safe half: rebuilding the index from
 * the fetched entries and running queries against it.
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

const EXCERPT_RADIUS = 72;
const RESULT_LIMIT = 8;
const ORAMA_HIT_LIMIT = 16;
const WHITESPACE_RE = /\s+/;

export const SEARCH_MIN_QUERY_LENGTH = 2;

export interface SearchResult {
  excerpt: string;
  href: string;
  kind: "page" | "section";
  section: string;
  title: string;
}

type ScoredResult = SearchResult & { order: number; score: number };

interface OramaHit {
  document: {
    content: string;
    description: string;
    href: string;
    kind: "page" | "section";
    order: number;
    section: string;
    title: string;
  };
  score: number;
}

function createExcerpt(content: string, description: string, query: string): string {
  const source = content.length > 0 ? content : description;
  if (source.length === 0) {
    return "";
  }

  const normalizedSource = source.toLowerCase();
  const queryTerms: string[] = [];
  for (const term of query.toLowerCase().split(WHITESPACE_RE)) {
    const trimmed = term.trim();
    if (trimmed.length > 0) {
      queryTerms.push(trimmed);
    }
  }

  const matchIndex = queryTerms.reduce((best, term) => {
    const idx = normalizedSource.indexOf(term);
    if (idx === -1) {
      return best;
    }
    return best === -1 || idx < best ? idx : best;
  }, -1);

  if (matchIndex === -1) {
    return source.length > 160 ? `${source.slice(0, 157).trimEnd()}...` : source;
  }

  const start = Math.max(0, matchIndex - EXCERPT_RADIUS);
  const end = Math.min(source.length, matchIndex + query.length + EXCERPT_RADIUS);
  return `${start > 0 ? "..." : ""}${source.slice(start, end).trim()}${end < source.length ? "..." : ""}`;
}

function deduplicateAndSort(hits: OramaHit[], trimmedQuery: string): SearchResult[] {
  const deduped = new Map<string, ScoredResult>();
  for (const hit of hits) {
    const doc = hit.document;
    const existing = deduped.get(doc.href);
    const next: ScoredResult = {
      excerpt: createExcerpt(doc.content, doc.description, trimmedQuery),
      href: doc.href,
      kind: doc.kind,
      order: doc.order,
      score: hit.score,
      section: doc.section,
      title: doc.title,
    };
    if (!existing || hit.score > existing.score) {
      deduped.set(doc.href, next);
    }
  }
  return [...deduped.values()]
    .toSorted((a, b) => (b.score === a.score ? a.order - b.order : b.score - a.score))
    .slice(0, RESULT_LIMIT)
    .map(({ order: _order, score: _score, ...result }) => result);
}

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

  return deduplicateAndSort(response.hits as unknown as OramaHit[], term);
}
