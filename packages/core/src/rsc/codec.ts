import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertInstalledRscVersions } from "./version.ts";

const MAX_FLIGHT_BYTES = 4 * 1024 * 1024;

interface ServerCodec {
  renderFlight(model: unknown, signal: AbortSignal | undefined): ReadableStream<Uint8Array>;
}

let serverCodecPromise: Promise<ServerCodec> | undefined;

function loadServerCodec(): Promise<ServerCodec> {
  if (serverCodecPromise !== undefined) {
    return serverCodecPromise;
  }

  serverCodecPromise = (async () => {
    const builtCodecPath = join(import.meta.dir, "rsc", "server-codec.js");
    if (existsSync(builtCodecPath)) {
      return import(pathToFileURL(builtCodecPath).href) as Promise<ServerCodec>;
    }
    const outdir = join(tmpdir(), `furin-rsc-${process.pid}-${Bun.hash(import.meta.url)}`);
    mkdirSync(outdir, { recursive: true });
    const sourcePath = join(import.meta.dir, "server-codec.ts");
    if (!existsSync(sourcePath)) {
      throw new Error(
        "[furin/rsc] The isolated Flight codec artifact is missing. Rebuild the application with the Furin Bun adapter."
      );
    }
    const result = await Bun.build({
      entrypoints: [sourcePath],
      outdir,
      target: "bun",
      format: "esm",
      conditions: ["react-server"],
      minify: false,
      sourcemap: "none",
    });
    if (!result.success || result.outputs.length !== 1) {
      const details = result.logs.map((log) => log.message).join("\n");
      throw new Error(`[furin/rsc] Failed to build the isolated RSC codec graph.\n${details}`);
    }
    const output = result.outputs[0];
    if (output === undefined) {
      throw new Error("[furin/rsc] Isolated RSC codec build produced no output.");
    }
    return import(pathToFileURL(output.path).href) as Promise<ServerCodec>;
  })();

  return serverCodecPromise;
}

export async function encodeFlight(
  model: unknown,
  signal: AbortSignal | undefined
): Promise<Uint8Array> {
  await assertInstalledRscVersions();
  const codec = await loadServerCodec();
  const bytes = new Uint8Array(await new Response(codec.renderFlight(model, signal)).arrayBuffer());
  if (bytes.byteLength > MAX_FLIGHT_BYTES) {
    throw new Error(
      `[furin/rsc] Flight payload exceeds the ${MAX_FLIGHT_BYTES}-byte safety limit.`
    );
  }
  return bytes;
}
