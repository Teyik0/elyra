import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_FLIGHT_BYTES = 4 * 1024 * 1024;

interface ServerCodec {
  renderFlight: (model: unknown, signal: AbortSignal | undefined) => ReadableStream<Uint8Array>;
}

let serverCodecPromise: Promise<ServerCodec> | undefined;

export function resolveConfiguredCodecPath(configuredPath: string | undefined): string | undefined {
  if (configuredPath === undefined || configuredPath.trim() === "") {
    return;
  }
  const codecPath = isAbsolute(configuredPath) ? configuredPath : resolve(configuredPath);
  return existsSync(codecPath) ? codecPath : undefined;
}

export function resolveBuiltCodecPath(
  moduleDir: string,
  executablePath: string | undefined
): string | undefined {
  const candidates = [join(moduleDir, "server-codec.js")];
  if (executablePath !== undefined && executablePath.trim() !== "") {
    candidates.push(join(dirname(executablePath), "server-codec.js"));
  }
  return candidates.find((candidate) => existsSync(candidate));
}

function loadServerCodec(): Promise<ServerCodec> {
  if (serverCodecPromise !== undefined) {
    return serverCodecPromise;
  }

  serverCodecPromise = (async () => {
    const configuredCodecPath = resolveConfiguredCodecPath(process.env.FURIN_RSC_CODEC_PATH);
    if (configuredCodecPath !== undefined) {
      return import(pathToFileURL(configuredCodecPath).href) as Promise<ServerCodec>;
    }
    const builtCodecPath = resolveBuiltCodecPath(import.meta.dir, process.execPath);
    if (builtCodecPath !== undefined) {
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
      conditions: ["react-server"],
      entrypoints: [sourcePath],
      format: "esm",
      minify: false,
      outdir,
      sourcemap: "none",
      target: "bun",
    });
    if (!result.success || result.outputs.length !== 1) {
      const details = result.logs.map((log) => log.message).join("\n");
      throw new Error(`[furin/rsc] Failed to build the isolated RSC codec graph.\n${details}`);
    }
    const [output] = result.outputs;
    if (output === undefined) {
      throw new Error("[furin/rsc] Isolated RSC codec build produced no output.");
    }
    return import(pathToFileURL(output.path).href) as Promise<ServerCodec>;
  })();

  return serverCodecPromise;
}

async function readFlightBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: stream chunks must be read sequentially.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_FLIGHT_BYTES) {
        await reader.cancel();
        throw new Error(
          `[furin/rsc] Flight payload exceeds the ${MAX_FLIGHT_BYTES}-byte safety limit.`
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function encodeFlight(
  model: unknown,
  signal: AbortSignal | undefined
): Promise<Uint8Array> {
  const codec = await loadServerCodec();
  return readFlightBytes(codec.renderFlight(model, signal));
}
