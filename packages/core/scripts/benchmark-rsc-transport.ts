import { benchmarkRscTransport } from "../src/rsc/transport-benchmark.ts";

const flightFixture = `0:["$","article",null,{"children":["$","h1",null,{"children":"Product"}]}]`;
const results = [1, 10, 100].map((count) => benchmarkRscTransport(flightFixture, count));

console.table(
  results.map((result) => ({
    composites: result.composites,
    winner: result.winner,
    templateGzip: result.template.compressedBytes,
    scriptGzip: result.script.compressedBytes,
    templateMemory: result.template.memoryBytes,
    scriptMemory: result.script.memoryBytes,
    templateScriptUnits: result.template.browserScriptUnits,
    scriptScriptUnits: result.script.browserScriptUnits,
  }))
);

if (results.some((result) => result.winner !== "template")) {
  throw new Error("Inert template transport exceeded the 5% compressed-byte budget.");
}
