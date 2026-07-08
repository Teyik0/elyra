import { DocPage } from "@/components/doc-page";
import DevHmr from "@/content/docs/dev-hmr.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route } from "./_route";

export default route.page({
  component: ({ markdownSource }) => (
    <DocPage Content={DevHmr} doc={DOCS_BY_PATH["/docs/dev-hmr"]} markdownSource={markdownSource} />
  ),
  head: () => ({
    meta: [{ title: "Dev Mode HMR — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/dev-hmr"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
});
