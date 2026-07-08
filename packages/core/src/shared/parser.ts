import { parse as babelParse, type ParserPlugin } from "@babel/parser";
import type { Program, SourceLang } from "@yuku-toolchain/types";

interface ParseDiagnostic {
  message: string;
  severity: "error";
}

interface ParseResult {
  diagnostics: ParseDiagnostic[];
  program: Program;
}

export function parseSource(code: string, lang: SourceLang): ParseResult {
  const plugins: ParserPlugin[] = ["estree"];
  if (lang === "ts" || lang === "tsx" || lang === "dts") {
    plugins.push("typescript");
  }
  if (lang === "jsx" || lang === "tsx") {
    plugins.push("jsx");
  }
  try {
    const file = babelParse(code, {
      createParenthesizedExpressions: true,
      plugins,
      sourceType: "module",
    });
    return { diagnostics: [], program: file.program as unknown as Program };
  } catch (error) {
    return {
      diagnostics: [
        {
          message: error instanceof Error ? error.message : String(error),
          severity: "error",
        },
      ],
      program: { body: [], sourceType: "module", type: "Program" } as unknown as Program,
    };
  }
}
