import { createElement } from "react";
import { FurinRscRenderError, renderServerComponent } from "../../../src/rsc-server.tsx";

const mode = Bun.argv.at(-1);

if (mode === "success") {
  await renderServerComponent(createElement("h1", null, "Direct RSC"));
  console.log(JSON.stringify({ type: "success" }));
} else if (mode === "render-error") {
  const cause = new Error("direct Flight render failed");
  function BrokenComponent(): never {
    throw cause;
  }

  try {
    await renderServerComponent(createElement(BrokenComponent));
    console.log(JSON.stringify({ type: "unexpected-success" }));
  } catch (error) {
    console.log(
      JSON.stringify({
        causeIsOriginal: error instanceof FurinRscRenderError && error.cause === cause,
        isFurinRscRenderError: error instanceof FurinRscRenderError,
        message: error instanceof Error ? error.message : String(error),
        operation: error instanceof FurinRscRenderError ? error.operation : undefined,
        type: "error",
      })
    );
  }
} else if (mode === "oversized") {
  try {
    await renderServerComponent(createElement("p", null, "x".repeat(4 * 1024 * 1024 + 64 * 1024)));
    console.log(JSON.stringify({ type: "unexpected-success" }));
  } catch (error) {
    console.log(
      JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
        type: "error",
      })
    );
  }
} else {
  throw new Error(`Unknown RSC server runtime scenario: ${mode}`);
}
