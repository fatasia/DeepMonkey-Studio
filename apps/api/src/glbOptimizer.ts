import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, draco, prune, simplify, weld } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import { MeshoptDecoder, MeshoptSimplifier } from "meshoptimizer";
import type { ModelLodResource } from "@bim-studio/contracts";
import { hasLegacyGlbMaterials, readTransformableGlb } from "./legacyGlbMaterials.js";

export interface GlbOptimizationResult {
  originalBytes: number;
  optimizedBytes: number;
  compressed: boolean;
}

let ioPromise: Promise<NodeIO> | undefined;

export async function generateGlbLods(filePath: string, outputDir = path.dirname(filePath)): Promise<Array<ModelLodResource & { fileName: string }>> {
  const originalBytes = (await stat(filePath)).size;
  if (originalBytes < 8_000_000 || process.env.GLB_LOD_ENABLED === "false") return [];
  await mkdir(outputDir, { recursive: true });
  await MeshoptSimplifier.ready;
  const io = await gltfIo();
  const legacy = await hasLegacyGlbMaterials(filePath);
  const specs = [
    { level: "medium" as const, ratio: 0.45, fileName: "lod-medium.glb", error: 0.002 },
    { level: "low" as const, ratio: 0.12, fileName: "lod-low.glb", error: 0.01 }
  ];
  const resources: Array<ModelLodResource & { fileName: string }> = [];
  for (const spec of specs) {
    const document = await readTransformableGlb(io, filePath);
    await document.transform(
      dedup(),
      weld(),
      simplify({ simplifier: MeshoptSimplifier, ratio: spec.ratio, error: spec.error, lockBorder: false }),
      prune({ keepAttributes: false, keepLeaves: false, ...(legacy ? { keepSolidTextures: true } : {}) }),
      draco({ method: "edgebreaker", encodeSpeed: 6, decodeSpeed: 6, quantizePosition: 16, quantizeNormal: 10, quantizeTexcoord: 12, quantizeColor: 8, quantizeGeneric: 12, quantizationVolume: "scene" })
    );
    const binary = await io.writeBinary(document);
    const outputPath = path.join(outputDir, spec.fileName);
    await writeFile(outputPath, binary);
    await io.read(outputPath);
    resources.push({ ...spec, url: spec.fileName });
  }
  return resources;
}

export async function optimizeNativeGlb(filePath: string): Promise<GlbOptimizationResult> {
  const originalBytes = (await stat(filePath)).size;
  const compress = originalBytes >= 1_000_000 && process.env.RVT_GLB_DRACO !== "false";
  const legacy = await hasLegacyGlbMaterials(filePath);
  if (!compress && !legacy) {
    return { originalBytes, optimizedBytes: originalBytes, compressed: false };
  }

  const io = await gltfIo();
  const document = await readTransformableGlb(io, filePath);
  if (compress) await document.transform(
    dedup(),
    weld(),
    prune(legacy ? { keepSolidTextures: true } : {}),
    draco({
      method: "edgebreaker",
      encodeSpeed: 5,
      decodeSpeed: 5,
      quantizePosition: 18,
      quantizeNormal: 10,
      quantizeTexcoord: 14,
      quantizeColor: 8,
      quantizeGeneric: 12,
      quantizationVolume: "scene"
    })
  );
  const binary = await io.writeBinary(document);
  if (!legacy && binary.byteLength >= originalBytes) {
    return { originalBytes, optimizedBytes: originalBytes, compressed: false };
  }

  const temporaryPath = `${filePath}.${randomUUID()}.optimized`;
  try {
    await writeFile(temporaryPath, binary);
    await io.read(temporaryPath);
    await copyFile(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return { originalBytes, optimizedBytes: binary.byteLength, compressed: compress && binary.byteLength < originalBytes };
}

async function gltfIo(): Promise<NodeIO> {
  ioPromise ??= Promise.all([
    draco3d.createEncoderModule(),
    draco3d.createDecoderModule(), MeshoptDecoder.ready
  ]).then(([encoder, decoder]) => new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      "draco3d.encoder": encoder,
      "draco3d.decoder": decoder,
      "meshopt.decoder": MeshoptDecoder
    }));
  return await ioPromise;
}
