import { describe, expect, test } from "bun:test";
import { benchmarkRscTransport } from "../../../src/rsc/transport-benchmark";

describe("RSC initial transport benchmark", () => {
  test.each([1, 10, 100])("selects inert templates for %i composites", (composites) => {
    const result = benchmarkRscTransport(`["$","article",null,{"children":"Product"}]`, composites);

    expect(result.winner).toBe("template");
    expect(result.template.browserScriptUnits).toBe(0);
    expect(result.template.compressedBytes).toBeLessThanOrEqual(
      Math.ceil(result.script.compressedBytes * 1.05)
    );
  });
});
