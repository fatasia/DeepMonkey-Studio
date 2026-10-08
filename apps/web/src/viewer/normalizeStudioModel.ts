import { parseGlb } from "@bim-studio/deep-engine/gltf";

/** Browser counterpart of the existing Native candidate Draco normalization. */
export async function normalizeStudioWasmModel(bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  if (bytes.byteLength < 20 || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) !== 0x46546c67) {
    return bytes;
  }
  const { json } = parseGlb(bytes);
  const document = json as { extensionsUsed?: unknown; extensionsRequired?: unknown };
  const declared = [...asStringArray(document.extensionsUsed), ...asStringArray(document.extensionsRequired)];
  if (!declared.includes("KHR_draco_mesh_compression")) return bytes;

  // Reuse the optimizer's pinned WebIO + Draco decoder; only the compression
  // extension is removed, while material semantics keep flowing through the
  // authoritative runtime-package compiler and its fail-closed validation.
  const { modelDecoderIO } = await import("../optimizer/modelOptimizerIO");
  const io = await modelDecoderIO(declared.includes("EXT_meshopt_compression"));
  signal.throwIfAborted();
  const gltf = await io.readBinary(bytes);
  for (const extension of gltf.getRoot().listExtensionsUsed()) {
    if (extension.extensionName === "KHR_draco_mesh_compression") extension.dispose();
  }
  const normalized = await io.writeBinary(gltf);
  signal.throwIfAborted();
  return normalized;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
