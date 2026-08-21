import { benchmarkRscTransport } from "../src/rsc/transport-benchmark.ts";

const flightFixture = `["$","article",null,{"children":["$","h1",null,{"children":"Product"}]}]`;
const results = [1, 10, 100].map((count) => benchmarkRscTransport(flightFixture, count));

console.table(
  results.map((result) => ({
    composites: result.composites,
    scriptGzip: result.script.compressedBytes,
    scriptMemory: result.script.memoryBytes,
    scriptScriptUnits: result.script.browserScriptUnits,
    templateGzip: result.template.compressedBytes,
    templateMemory: result.template.memoryBytes,
    templateScriptUnits: result.template.browserScriptUnits,
    winner: result.winner,
  }))
);

if (results.some((result) => result.winner !== "template")) {
  throw new Error("Inert template transport exceeded the 5% compressed-byte budget.");
}
