import { type ParseResult, parse, type SourceLang } from "yuku-parser";

export function parseSource(code: string, lang: SourceLang): ParseResult {
  return parse(code, { lang, sourceType: "module" });
}
