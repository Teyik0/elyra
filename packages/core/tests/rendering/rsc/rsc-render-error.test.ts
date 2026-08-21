import { expect, test } from "bun:test";

interface RscRenderErrorResult {
  causeIsTypeError: boolean;
  component: string | undefined;
  hook: string | undefined;
  isFurinRscRenderError: boolean;
  message: string;
  routeHtml?: string;
  routeStatus?: number;
  stack: string | undefined;
  type: "error" | "unexpected-success";
}

function runRscRenderErrorScenario(): Promise<RscRenderErrorResult> {
  const worker = new Worker(new URL("./rsc-render-error.scenario.tsx", import.meta.url), {
    type: "module",
  });

  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<RscRenderErrorResult>) => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(event.error ?? new Error(event.message));
    };
  });
}

function runRenderServerErrorScenario(): Promise<RscRenderErrorResult & { operation?: string }> {
  const worker = new Worker(new URL("./rsc-render-server-error.scenario.tsx", import.meta.url), {
    type: "module",
  });

  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<RscRenderErrorResult & { operation?: string }>) => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(event.error ?? new Error(event.message));
    };
  });
}

test("createCompositeComponent reports client-only hooks at the Flight boundary", async () => {
  const result = await runRscRenderErrorScenario();

  expect(result).toMatchObject({
    causeIsTypeError: true,
    component: "HookComponent",
    hook: "useContext",
    isFurinRscRenderError: true,
    type: "error",
  });
  expect(result.message).toBe(
    `[furin/rsc] A component rendered inside createCompositeComponent()
used a client-only React hook.

Component: HookComponent
Hook: useContext

Move this component behind a CompositeComponent slot:
createCompositeComponent(({ Icon }) => <Icon />)`
  );
  expect(result.stack).toContain("HookComponent");
  expect(result.routeStatus).toBe(500);
  expect(result.routeHtml).toContain("Component: HookComponent");
  expect(result.routeHtml).toContain("Hook: useContext");
});

test("renderServerComponent rejects before Flight decoding", async () => {
  const result = await runRenderServerErrorScenario();

  expect(result).toMatchObject({
    component: "HookComponent",
    hook: "useContext",
    isFurinRscRenderError: true,
    operation: "renderServerComponent",
    type: "error",
  });
  expect(result.message).toContain(
    "[furin/rsc] A component rendered inside renderServerComponent()"
  );
});
