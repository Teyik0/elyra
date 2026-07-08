import { DocPage } from "@/components/doc-page";
import Logging from "@/content/docs/logging.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route } from "./_route";

export default route.page({
  component: ({ markdownSource }) => (
    <DocPage
      Content={Logging}
      doc={DOCS_BY_PATH["/docs/logging"]}
      markdownSource={markdownSource}
    />
  ),
  head: () => ({
    meta: [{ title: "Logging — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/logging"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
});
