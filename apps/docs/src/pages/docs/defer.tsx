import { DocPage } from "@/components/doc-page";
import Defer from "@/content/docs/defer.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route } from "./_route";

export default route.page({
  component: ({ markdownSource }) => (
    <DocPage Content={Defer} doc={DOCS_BY_PATH["/docs/defer"]} markdownSource={markdownSource} />
  ),
  head: () => ({
    meta: [{ title: "Deferred Data — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/defer"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
});
