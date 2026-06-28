import { createElement, Fragment, type ReactElement, type ReactNode } from "react";

declare const renderableServerComponent: unique symbol;
const compositeComponent = Symbol("furin.composite-component");

export type RenderableServerComponent<TNode extends ReactNode = ReactNode> = ReactElement & {
  readonly [renderableServerComponent]: TNode;
};

export interface CompositeComponentSource<TProps extends object> {
  readonly [compositeComponent]: (props: TProps) => ReactNode | Promise<ReactNode>;
}

export type CompositeComponentProps<TProps extends object> = Omit<TProps, "src"> & {
  src: CompositeComponentSource<TProps>;
};

export function renderServerComponent<TNode extends ReactNode>(
  node: TNode
): Promise<RenderableServerComponent<TNode>> {
  const element = createElement(Fragment, null, node) as RenderableServerComponent<TNode>;
  return Promise.resolve(element);
}

export function createCompositeComponent<TProps extends object>(
  component: (props: TProps) => ReactNode | Promise<ReactNode>
): Promise<CompositeComponentSource<TProps>> {
  return Promise.resolve({ [compositeComponent]: component });
}

export function CompositeComponent<TProps extends object>(
  props: CompositeComponentProps<TProps>
): ReactNode | Promise<ReactNode> {
  const { src, ...slots } = props;
  return src[compositeComponent](slots as TProps);
}
