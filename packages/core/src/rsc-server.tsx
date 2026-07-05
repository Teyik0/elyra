import { createElement, type ReactNode } from "react";
import { renderToReadableStream } from "react-server-dom-webpack/server.edge";
import type { CompositeComponentSource, RenderableServerComponent } from "./rsc/shared.tsx";
import { RSC_SOURCE, SLOT_MARKER } from "./rsc/symbols.ts";

async function renderBytes(node: ReactNode): Promise<Uint8Array> {
  const stream = renderToReadableStream(node, {});
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function renderServerComponent<TNode extends ReactNode>(
  node: TNode
): Promise<RenderableServerComponent<TNode>> {
  const bytes = await renderBytes(node);
  return {
    [RSC_SOURCE]: { bytes, kind: "renderable", tree: Promise.resolve(null) },
  } as unknown as RenderableServerComponent<TNode>;
}

function createSlotProxy<TProps extends object>(): TProps {
  return new Proxy({} as TProps, {
    get(_target, property) {
      if (property === "then" || typeof property !== "string") {
        return;
      }
      if (property === "children") {
        return createElement(SLOT_MARKER, { name: property, args: [] });
      }
      return (...args: unknown[]) => createElement(SLOT_MARKER, { name: property, args });
    },
  });
}

export async function createCompositeComponent<TProps extends object>(
  component: (props: TProps) => ReactNode | Promise<ReactNode>
): Promise<CompositeComponentSource<TProps>> {
  const proxy = createSlotProxy<TProps>();
  function Tree(): ReactNode | Promise<ReactNode> {
    return component(proxy);
  }
  const bytes = await renderBytes(createElement(Tree));
  return {
    [RSC_SOURCE]: { bytes, kind: "composite", tree: Promise.resolve(null) },
  };
}

export function CompositeComponent(): never {
  throw new Error("[furin/rsc] CompositeComponent cannot render inside the RSC graph");
}
