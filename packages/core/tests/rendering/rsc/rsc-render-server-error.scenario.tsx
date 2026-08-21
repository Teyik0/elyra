import { createContext, createElement, useContext } from "react";
import { FurinRscRenderError, renderServerComponent } from "../../../src/rsc.tsx";

process.env.FURIN_RSC_CODEC_PATH = "";

const Context = createContext("value");

function HookComponent() {
  return createElement("span", null, useContext(Context));
}

try {
  await renderServerComponent(createElement(HookComponent));
  self.postMessage({ type: "unexpected-success" });
} catch (error) {
  self.postMessage({
    component: error instanceof FurinRscRenderError ? error.component : undefined,
    hook: error instanceof FurinRscRenderError ? error.hook : undefined,
    isFurinRscRenderError: error instanceof FurinRscRenderError,
    message: error instanceof Error ? error.message : String(error),
    operation: error instanceof FurinRscRenderError ? error.operation : undefined,
    type: "error",
  });
}
