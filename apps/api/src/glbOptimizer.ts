import { copyFile, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { NodeIO } from "@gltf-transform/core";
import { KHRDracoMeshCompression } from "@gltf-transform/extensions";
import { dedup, draco, prune, weld } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";

export interface GlbOptimizationResult {
  originalBytes: number;
  optimizedBytes: number;
  compressed: boolean;
}

let ioPromise: Promise<NodeIO> | undefined;

export async function optimizeNativeGlb(filePath: string): Promise<GlbOptimizationResult> {
  const originalBytes = (await stat(filePath)).size;
  if (originalBytes < 1_000_000 || process.env.RVT_GLB_DRACO === "false") {
    return { originalBytes, optimizedBytes: originalBytes, compressed: false };
  }

  const io = await gltfIo();
  const document = await io.read(filePath);
  await document.transform(
    dedup(),
    weld(),
    prune(),
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
  if (binary.byteLength >= originalBytes) {
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
  return { originalBytes, optimizedBytes: binary.byteLength, compressed: true };
}

async function gltfIo(): Promise<NodeIO> {
  ioPromise ??= Promise.all([
    draco3d.createEncoderModule(),
    draco3d.createDecoderModule()
  ]).then(([encoder, decoder]) => new NodeIO()
    .registerExtensions([KHRDracoMeshCompression])
    .registerDependencies({
      "draco3d.encoder": encoder,
      "draco3d.decoder": decoder
    }));
  return await ioPromise;
}
