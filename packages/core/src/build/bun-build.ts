type BunBuild = typeof Bun.build;

type BunBuildGlobal = typeof globalThis & {
  __FURIN_BUN_BUILD_FOR_TESTS?: BunBuild;
};

export function runBunBuild(config: Bun.BuildConfig): ReturnType<BunBuild> {
  return (((globalThis as BunBuildGlobal).__FURIN_BUN_BUILD_FOR_TESTS ?? Bun.build) as BunBuild)(
    config
  );
}
