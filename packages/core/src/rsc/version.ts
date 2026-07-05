import React from "react";
import { version as reactDomVersion } from "react-dom";

export interface RscVersions {
  react: string;
  reactDom: string;
  reactServerDom: string;
}

export function assertCompatibleRscVersions(versions: RscVersions): void {
  if (versions.react !== versions.reactDom || versions.react !== versions.reactServerDom) {
    throw new Error(
      "[furin/rsc] React package versions must match exactly: " +
        `react=${versions.react}, react-dom=${versions.reactDom}, ` +
        `react-server-dom-webpack=${versions.reactServerDom}.`
    );
  }
  const [major, minor, patch] = versions.react.split(".").map(Number);
  if (major === 19 && minor === 2 && (patch ?? 0) < 1) {
    throw new Error("[furin/rsc] React 19.2.0 is insecure; use the pinned patched React line.");
  }
}

let checked: Promise<void> | undefined;

export function assertInstalledRscVersions(): Promise<void> {
  if (checked !== undefined) {
    return checked;
  }
  checked = (async () => {
    const packageUrl = new URL(
      "./package.json",
      import.meta.resolve("react-server-dom-webpack/server.edge")
    );
    const metadata = (await Bun.file(packageUrl).json()) as { version?: unknown };
    if (typeof metadata.version !== "string") {
      throw new Error("[furin/rsc] Cannot determine the installed Flight codec version.");
    }
    assertCompatibleRscVersions({
      react: React.version,
      reactDom: reactDomVersion,
      reactServerDom: metadata.version,
    });
  })();
  return checked;
}
