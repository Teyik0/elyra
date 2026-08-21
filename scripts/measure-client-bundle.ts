interface ClientAsset {
  gzipBytes: number;
  path: string;
  rawBytes: number;
}

const decoder = new TextDecoder();
const formatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

function formatKilobytes(bytes: number): string {
  return `${formatter.format(bytes / 1024)} KiB`;
}

function getDirectory(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const slashIndex = normalized.lastIndexOf("/");

  if (slashIndex === -1) {
    return ".";
  }

  if (slashIndex === 0) {
    return "/";
  }

  return normalized.slice(0, slashIndex);
}

function joinPath(rootDir: string, assetPath: string): string {
  const cleanAssetPath = assetPath.split("?")[0]?.split("#")[0];

  if (!cleanAssetPath) {
    throw new Error(`Invalid asset path: ${assetPath}`);
  }

  if (cleanAssetPath.startsWith("/_client/")) {
    return `${rootDir}/${cleanAssetPath.slice("/_client/".length)}`;
  }

  if (cleanAssetPath.startsWith("/")) {
    return `${rootDir}${cleanAssetPath}`;
  }

  return `${rootDir}/${cleanAssetPath}`;
}

function isLocalAssetPath(assetPath: string): boolean {
  if (assetPath.startsWith("//")) {
    return false;
  }

  if (URL.canParse(assetPath)) {
    return false;
  }
  return true;
}

function extractClientAssetPaths(sourceHtml: string): string[] {
  const assetPaths = new Set<string>();
  const attributePattern = /\b(?:src|href)=["']([^"']+\.(?:js|css)(?:[?#][^"']*)?)["']/g;

  for (const match of sourceHtml.matchAll(attributePattern)) {
    const [, assetPath] = match;

    if (assetPath !== undefined && isLocalAssetPath(assetPath)) {
      assetPaths.add(assetPath);
    }
  }

  return [...assetPaths].toSorted();
}

async function measureAsset(rootDir: string, assetPath: string): Promise<ClientAsset> {
  const filePath = joinPath(rootDir, assetPath);
  const bytes = new Uint8Array(await Bun.file(filePath).arrayBuffer());

  return {
    gzipBytes: Bun.gzipSync(bytes).byteLength,
    path: assetPath,
    rawBytes: bytes.byteLength,
  };
}

function printUsage(): void {
  console.error("Usage: bun scripts/measure-client-bundle.ts <path-to-client-index.html>");
}

const [, , htmlPath] = Bun.argv;

if (htmlPath === undefined) {
  printUsage();
  process.exit(1);
}

const htmlFile = Bun.file(htmlPath);

if (!(await htmlFile.exists())) {
  console.error(`Client HTML not found: ${htmlPath}`);
  process.exit(1);
}

const documentHtml = decoder.decode(await htmlFile.arrayBuffer());
const htmlBaseDir = getDirectory(htmlPath);
const assetPaths = extractClientAssetPaths(documentHtml);

if (assetPaths.length === 0) {
  console.error(`No client JS or CSS assets found in: ${htmlPath}`);
  process.exit(1);
}

const assets = await Promise.all(
  assetPaths.map((assetPath) => measureAsset(htmlBaseDir, assetPath))
);
const totals = assets.reduce(
  (current, asset) => ({
    gzipBytes: current.gzipBytes + asset.gzipBytes,
    rawBytes: current.rawBytes + asset.rawBytes,
  }),
  { gzipBytes: 0, rawBytes: 0 }
);

for (const asset of assets) {
  console.log(
    `${asset.path}  raw=${formatKilobytes(asset.rawBytes)}  gzip=${formatKilobytes(asset.gzipBytes)}`
  );
}

console.log(
  `total  raw=${formatKilobytes(totals.rawBytes)}  gzip=${formatKilobytes(totals.gzipBytes)}`
);

export {};
