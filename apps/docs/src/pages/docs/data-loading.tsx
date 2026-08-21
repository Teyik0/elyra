import { DocPage } from "@/components/doc-page";
import DataLoading from "@/content/docs/data-loading.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route } from "./_route";

export default route.page({
  component: ({ markdownSource }) => (
    <DocPage
      Content={DataLoading}
      doc={DOCS_BY_PATH["/docs/data-loading"]}
      markdownSource={markdownSource}
    />
  ),
  head: () => ({
    meta: [{ title: "Data Loading — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/data-loading"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
});
