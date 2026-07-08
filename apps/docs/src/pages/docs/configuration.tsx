import { DocPage } from "@/components/doc-page";
import Configuration from "@/content/docs/configuration.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route } from "./_route";

export default route.page({
  component: ({ markdownSource }) => (
    <DocPage
      Content={Configuration}
      doc={DOCS_BY_PATH["/docs/configuration"]}
      markdownSource={markdownSource}
    />
  ),
  head: () => ({
    meta: [{ title: "Configuration — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/configuration"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
});
