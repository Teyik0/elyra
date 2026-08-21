export type IsomorphicFn<
  TArguments extends unknown[] = [],
  TServer = undefined,
  TClient = undefined,
> = (...arguments_: TArguments) => TServer | TClient;

export interface ServerIsomorphicFn<TArguments extends unknown[], TServer>
  extends IsomorphicFn<TArguments, TServer> {
  client: <TClient>(
    implementation: (...arguments_: TArguments) => TClient
  ) => IsomorphicFn<TArguments, TServer, TClient>;
}

export interface ClientIsomorphicFn<TArguments extends unknown[], TClient>
  extends IsomorphicFn<TArguments, undefined, TClient> {
  server: <TServer>(
    implementation: (...arguments_: TArguments) => TServer
  ) => IsomorphicFn<TArguments, TServer, TClient>;
}

export interface IsomorphicFnBuilder extends IsomorphicFn {
  client: <TArguments extends unknown[], TClient>(
    implementation: (...arguments_: TArguments) => TClient
  ) => ClientIsomorphicFn<TArguments, TClient>;
  server: <TArguments extends unknown[], TServer>(
    implementation: (...arguments_: TArguments) => TServer
  ) => ServerIsomorphicFn<TArguments, TServer>;
}

type RuntimeImplementation = (...arguments_: unknown[]) => unknown;

interface RuntimeIsomorphicFn {
  client: (implementation: RuntimeImplementation) => RuntimeIsomorphicFn;
  server: (implementation: RuntimeImplementation) => RuntimeIsomorphicFn;
  (...arguments_: unknown[]): unknown;
}

const UNCOMPILED_BROWSER_ERROR =
  "[furin] createIsomorphicFn() reached the browser without being compiled. " +
  "Register @teyik0/furin/strip-plugin in bunfig.toml.";

function createRuntimeFn(
  serverImplementation: RuntimeImplementation | undefined
): RuntimeIsomorphicFn {
  const runtime = (...arguments_: unknown[]): unknown => {
    if (typeof window !== "undefined") {
      throw new Error(UNCOMPILED_BROWSER_ERROR);
    }
    return serverImplementation?.(...arguments_);
  };

  return Object.assign(runtime, {
    client: (_implementation: RuntimeImplementation) => createRuntimeFn(serverImplementation),
    server: (implementation: RuntimeImplementation) => createRuntimeFn(implementation),
  });
}

/**
 * Creates one callable with environment-specific implementations.
 *
 * Furin replaces the fluent chain at build time. This runtime fallback exists
 * for Bun's server-side module evaluation during route discovery and SSG.
 */
export function createIsomorphicFn(): IsomorphicFnBuilder {
  return createRuntimeFn(undefined) as IsomorphicFnBuilder;
}
