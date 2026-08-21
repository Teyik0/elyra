import { DocPage } from "@/components/doc-page";
import ErrorHandling from "@/content/docs/error-handling.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route } from "./_route";

export default route.page({
  component: ({ markdownSource }) => (
    <DocPage
      Content={ErrorHandling}
      doc={DOCS_BY_PATH["/docs/error-handling"]}
      markdownSource={markdownSource}
    />
  ),
  head: () => ({
    meta: [{ title: "Error Handling — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/error-handling"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
});
