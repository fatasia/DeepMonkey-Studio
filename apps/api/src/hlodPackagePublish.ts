import { createHash } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { encodeHlodProxyGeometries } from "@bim-studio/deep-engine/hlod";
import { buildHlodPackage } from "./hlodPackageSource.js";
import { serializeHlodPackageManifest } from "./hlodPackageManifest.js";
import { extractHlodInstancesFromGlb } from "./hlodPackageSceneInput.js";
import type { DeepAssetPackageFileInput } from "./deepAssetPackageBuilder.js";

export interface PublishedHlodSidecars {
  readonly files: readonly DeepAssetPackageFileInput[];
  readonly manifestHash: string;
  readonly proxyHash: string;
}

/** Content-addressed, immutable names let concurrent conversions avoid overwriting each other's staging source. */
export async function prepareHlodSidecars(outputDir: string, geometryFileName: string,
  signal?: AbortSignal): Promise<PublishedHlodSidecars> {
  signal?.throwIfAborted();
  const extracted = await extractHlodInstancesFromGlb(path.join(outputDir, geometryFileName));
  signal?.throwIfAborted();
  const result = buildHlodPackage(extracted.instances);
  const manifest = Buffer.from(serializeHlodPackageManifest(result.manifest), "utf8");
  const binary = Buffer.from(encodeHlodProxyGeometries(result.geometries));
  const manifestHash = createHash("sha256").update(manifest).digest("hex");
  const proxyHash = createHash("sha256").update(binary).digest("hex");
  signal?.throwIfAborted();
  const manifestName = `hlod-manifest-${manifestHash}.json`;
  const proxyName = `hlod-proxies-${proxyHash}.bin`;
  await Promise.all([
    writeImmutable(path.join(outputDir, manifestName), manifest),
    writeImmutable(path.join(outputDir, proxyName), binary),
  ]);
  signal?.throwIfAborted();
  return {
    manifestHash, proxyHash,
    files: [
      { id: "metadata:hlod-manifest", kind: "metadata", logicalPath: `output/${manifestName}`,
        fileName: manifestName, mediaType: "application/json" },
      { id: "mesh:hlod-proxies", kind: "mesh", logicalPath: `output/${proxyName}`,
        fileName: proxyName, mediaType: "application/octet-stream" },
    ],
  };
}

async function writeImmutable(target: string, bytes: Buffer): Promise<void> {
  try { await writeFile(target, bytes, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A concurrent generation may have produced the same content-addressed name.
    // Never truncate it; package staging rehashes source bytes before CAS commit.
    await access(target);
  }
}
