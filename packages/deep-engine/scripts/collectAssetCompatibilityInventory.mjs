import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const defaultRepositoryRoot = path.resolve(scriptDirectory, "../../..");

const sourcePaths = {
  extensions: "packages/contracts/src/project.ts",
  catalog: "packages/contracts/src/modelFormatCatalog.ts",
  conversion: "apps/api/src/conversion.ts",
  unityRoutes: "apps/api/src/unityResourceRoutes.ts",
  unityInspection: "apps/api/src/unityBuildInspection.ts",
  unityPlayer: "apps/web/src/components/UnitySceneEmbed.tsx",
  unityPackage: "tools/unity/com.bim-studio.bridge/package.json",
};

export async function collectAssetCompatibilityInventory(repositoryRoot = defaultRepositoryRoot) {
  const entries = await Promise.all(Object.entries(sourcePaths).map(async ([key, relativePath]) => {
    const bytes = await readFile(path.join(repositoryRoot, relativePath));
    return [key, { relativePath, bytes, source: bytes.toString("utf8") }];
  }));
  const sources = Object.fromEntries(entries);
  const extensions = extractStringArray(sources.extensions.source, "supportedExtensions");
  const catalog = extractCatalog(sources.catalog.source);
  const packageManifest = JSON.parse(sources.unityPackage.source);

  return {
    schemaVersion: 1,
    supportedExtensionCount: extensions.length,
    supportedExtensions: extensions,
    catalogCoverage: extensions.map((extension) => ({
      extension,
      ...findCatalogEntry(catalog, extension),
    })),
    routeEvidence: classifyRoutes(extensions, sources.conversion.source),
    unityEvidence: {
      packageName: packageManifest.name,
      packageVersion: packageManifest.version,
      displayName: packageManifest.displayName,
      acceptsWebBuildZip: sources.unityRoutes.source.includes("请选择 Unity WebGL ZIP"),
      requiresWebBuildRuntimeFiles: ["loader", "framework", "wasm", "data"].every((role) =>
        sources.unityInspection.source.includes(`[${role},`)),
      rendersInIframe: /<iframe\b/.test(sources.unityPlayer.source),
      acceptsUnityPackage: sources.unityRoutes.source.includes(".unitypackage"),
      acceptsAssetBundle: /AssetBundle|\.bundle\b/.test(sources.unityRoutes.source),
    },
    sourceEvidence: Object.values(sources).map(({ relativePath, bytes }) => ({
      path: relativePath.replaceAll("\\", "/"),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  };
}

export function extractStringArray(source, exportName) {
  const marker = `export const ${exportName} = [`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${exportName} declaration`);
  const end = source.indexOf("] as const", start);
  if (end < 0) throw new Error(`Unterminated ${exportName} declaration`);
  const body = source.slice(start + marker.length, end).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return [...body.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);
}

function extractCatalog(source) {
  const entries = [];
  const pattern = /declaredCapability\(\{\s*id:\s*"([^"]+)"[\s\S]*?extensions:\s*\[([^\]]+)\][\s\S]*?scope:\s*"(core|optional|excluded)"/g;
  for (const match of source.matchAll(pattern)) {
    entries.push({
      id: match[1],
      extensions: [...match[2].matchAll(/"([a-z0-9_]+)"/g)].map((item) => item[1]),
      scope: match[3],
    });
  }
  return entries;
}

function findCatalogEntry(catalog, extension) {
  const entry = catalog.find((candidate) => candidate.extensions.includes(extension));
  return entry ? { capabilityId: entry.id, catalogScope: entry.scope } : { capabilityId: null, catalogScope: null };
}

function classifyRoutes(extensions, conversionSource) {
  const legacy = new Set(["ifc", "fbx", "dxf", "obj", "stl", "3mf", "dae", "3ds", "usd", "usda", "usdc", "usdz"]);
  const converted = new Set(["step", "stp", "iges", "igs"]);
  const conditional = new Set(["dwg", "rvt", "x_b", "urdf", "zip"]);
  const subset = new Set(["x_t", "jt"]);
  return extensions.map((extension) => {
    let currentRoute = "direct";
    if (legacy.has(extension)) currentRoute = "legacy-browser";
    else if (converted.has(extension)) currentRoute = "convert";
    else if (conditional.has(extension)) currentRoute = "provider";
    else if (subset.has(extension)) currentRoute = "subset";
    const declared = new RegExp(`\\b["']?${extension}["']?\\s*:`).test(conversionSource);
    return { extension, currentRoute, conversionProviderDeclared: declared };
  });
}

async function main() {
  process.stdout.write(`${JSON.stringify(await collectAssetCompatibilityInventory(), null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
