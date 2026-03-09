export let IS_DEV = process.env.NODE_ENV !== "production";

/** @internal test-only — overrides IS_DEV via live binding */
export function __setDevMode(val: boolean): void {
  IS_DEV = val;
}
