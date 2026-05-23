/**
 * Browser-safe search primitives shared between the server index
 * (`docs-search.ts`) and the client runtime (`docs-search-client.ts`).
 * Keeping excerpt + dedup/sort here prevents behavior drift across the
 * two search paths.
 */

export interface SearchIndexEntry {
  content: string;
  description: string;
  href: string;
  id: string;
  kind: "page" | "section";
  order: number;
  section: string;
  title: string;
}

export interface SearchResult {
  excerpt: string;
  href: string;
  kind: "page" | "section";
  section: string;
  title: string;
}

export interface SearchHit {
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

export const SEARCH_MIN_QUERY_LENGTH = 2;
export const SEARCH_DEFAULT_LIMIT = 8;

const EXCERPT_RADIUS = 72;
const WHITESPACE_RE = /\s+/;

export function createExcerpt(content: string, description: string, query: string): string {
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

  const matchIndex = queryTerms.reduce((bestIndex, term) => {
    const index = normalizedSource.indexOf(term);
    if (index === -1) {
      return bestIndex;
    }
    if (bestIndex === -1 || index < bestIndex) {
      return index;
    }
    return bestIndex;
  }, -1);

  if (matchIndex === -1) {
    return source.length > 160 ? `${source.slice(0, 157).trimEnd()}...` : source;
  }

  const start = Math.max(0, matchIndex - EXCERPT_RADIUS);
  const end = Math.min(source.length, matchIndex + query.length + EXCERPT_RADIUS);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < source.length ? "..." : "";

  return `${prefix}${source.slice(start, end).trim()}${suffix}`;
}

export function dedupeAndSortHits(hits: SearchHit[], query: string, limit: number): SearchResult[] {
  type Scored = SearchResult & { order: number; score: number };
  const deduped = new Map<string, Scored>();

  for (const hit of hits) {
    const doc = hit.document;
    const existing = deduped.get(doc.href);
    const next: Scored = {
      excerpt: createExcerpt(doc.content, doc.description, query),
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
    .slice(0, limit)
    .map(({ order: _order, score: _score, ...result }) => result);
}
