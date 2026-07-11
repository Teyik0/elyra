import { createElement, type ReactNode } from "react";
import { renderToReadableStream } from "react-server-dom-webpack/server.edge";
import type {
  CompositeComponentSource,
  RenderableServerComponent,
  RscSourceState,
} from "./rsc/shared.tsx";
import { RSC_SOURCE, SLOT_MARKER } from "./rsc/symbols.ts";

async function renderBytes(node: ReactNode): Promise<Uint8Array> {
  const stream = renderToReadableStream(node, {});
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function RscNode({ state }: { state: RscSourceState }): Promise<ReactNode> {
  return (await state.tree) as ReactNode;
}

function createServerRenderableSource<TNode extends ReactNode>(
  state: RscSourceState
): RenderableServerComponent<TNode> {
  const element = createElement(RscNode, { state });
  return new Proxy(element, {
    get(target, property, receiver) {
      if (property === RSC_SOURCE) {
        return state;
      }
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      return property === RSC_SOURCE || Reflect.has(target, property);
    },
  }) as RenderableServerComponent<TNode>;
}

export async function renderServerComponent<TNode extends ReactNode>(
  node: TNode
): Promise<RenderableServerComponent<TNode>> {
  const bytes = await renderBytes(node);
  return createServerRenderableSource<TNode>({
    bytes,
    kind: "renderable",
    tree: Promise.resolve(node),
  });
}

function createSlotProxy<TProps extends object>(): TProps {
  return new Proxy({} as TProps, {
    get(_target, property) {
      if (property === "then" || typeof property !== "string") {
        return;
      }
      if (property === "children") {
        return createElement(SLOT_MARKER, { args: [], name: property });
      }
      return (...args: unknown[]) => createElement(SLOT_MARKER, { args, name: property });
    },
  });
}

type CompositePropsWithSupportedChildren<TProps extends object> = TProps extends {
  children?: infer TChildren;
}
  ? TChildren extends ReactNode | undefined
    ? TProps
    : never
  : TProps;

export async function createCompositeComponent<TProps extends object>(
  component: (props: CompositePropsWithSupportedChildren<TProps>) => ReactNode | Promise<ReactNode>
): Promise<CompositeComponentSource<TProps>> {
  const proxy = createSlotProxy<CompositePropsWithSupportedChildren<TProps>>();
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
