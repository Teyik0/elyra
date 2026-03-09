import { resolve } from "node:path";

const CLI_ENTRY = resolve(import.meta.dir, "../../src/cli/index.ts");

export interface CliResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface RunningCli {
  exitCode: Promise<number>;
  getStderr: () => string;
  getStdout: () => string;
  kill: () => void;
}

function decodeBuffer(buffer?: Uint8Array<ArrayBufferLike>): string {
  return buffer ? new TextDecoder().decode(buffer) : "";
}

export function runCli(
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string | undefined>;
  }
): CliResult {
  const proc = Bun.spawnSync(["bun", CLI_ENTRY, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    stderr: "pipe",
    stdout: "pipe",
  });

  return {
    exitCode: proc.exitCode,
    stdout: decodeBuffer(proc.stdout),
    stderr: decodeBuffer(proc.stderr),
  };
}

async function collectStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onChunk: (chunk: string) => void
): Promise<void> {
  if (!stream) {
    return;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    onChunk(decoder.decode(value, { stream: true }));
  }

  const flush = decoder.decode();
  if (flush) {
    onChunk(flush);
  }
}

export function startCli(
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string | undefined>;
  }
): RunningCli {
  return startProcess(["bun", CLI_ENTRY, ...args], options);
}

export function startProcess(
  command: string[],
  options: {
    cwd: string;
    env?: Record<string, string | undefined>;
  }
): RunningCli {
  let stdout = "";
  let stderr = "";

  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    stderr: "pipe",
    stdout: "pipe",
  });

  const stdoutPromise = collectStream(proc.stdout, (chunk) => {
    stdout += chunk;
  });
  const stderrPromise = collectStream(proc.stderr, (chunk) => {
    stderr += chunk;
  });

  return {
    getStdout: () => stdout,
    getStderr: () => stderr,
    kill: () => {
      proc.kill();
    },
    exitCode: (async () => {
      const code = await proc.exited;
      await Promise.all([stdoutPromise, stderrPromise]);
      return code;
    })(),
  };
}
