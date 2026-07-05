// biome-ignore-all lint/performance/noBarrelFile: browser condition for the public furin/rsc entrypoint

export * from "./rsc/shared.tsx";

export function renderServerComponent(): never {
  throw new Error("[furin/rsc] renderServerComponent() is server-only");
}

export function createCompositeComponent(): never {
  throw new Error("[furin/rsc] createCompositeComponent() is server-only");
}
