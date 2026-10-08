import { validateRenderPacket } from "../renderPacket.js";
import { STOCK_MATERIAL_INSTANCE_OPTIONS } from "../materialInstanceAbi.js";
import { createOwnedRuntimePackageCore } from "./builder.js";
import { hashOwnedRuntimeJson, orderedRuntimeJson } from "./hash.js";
import { requireValue } from "./primitives.js";
import { validateOwnedBuiltRuntimePackage } from "./validation.js";
import type { BuildDeepRuntimePackageInput, RuntimeJson, RuntimeResourceIndexEntry } from "./types.js";

/** Internal typed transport. Published JSON remains a separate, unchanged format. */
export const RUNTIME_BINARY_MAGIC = "DMPBIN1\n";
interface Section { path: string; encoding: "f32le" | "u32le" | "rgba8"; offset: number; length: number; sha256: string;
  compression?: "deflate"; decodedLength?: number }
const MAX_BYTES = 256 * 1024 * 1024, MAX_HEADER = 4 * 1024 * 1024;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, value => value.toString(16).padStart(2, "0")).join("");
}

export async function buildDeepRuntimePackageBinaryArtifactAsync(input: BuildDeepRuntimePackageInput,
  options: { readonly signal?: AbortSignal } = {}) {
  const signal = options.signal;
  signal?.throwIfAborted();
  validateRenderPacket(input.renderPacket.value, STOCK_MATERIAL_INSTANCE_OPTIONS);
  // Static-lightmap descriptors hash the published texture JSON itself. Keep
  // that profile on the original serializer until it has a versioned binary hash.
  requireValue(!(input.environment as { staticLightmap?: unknown } | undefined)?.staticLightmap,
    "$.environment", "Static lightmaps require the JSON runtime transport.");
  const sections: Section[] = [], planes: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  const add = (path: string, source: Float32Array | Uint32Array | Uint8Array, encoding: Section["encoding"]) => {
    signal?.throwIfAborted();
    requireValue(source.buffer instanceof ArrayBuffer && source.byteLength > 0, path, "Expected nonempty unshared binary plane.");
    requireValue(offset + source.byteLength <= MAX_BYTES, path, "Binary runtime exceeds 256 MiB.");
    // Own every caller plane before the first asynchronous hash can yield.
    let bytes = Uint8Array.from(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
    if (!LITTLE_ENDIAN && encoding !== "rgba8") {
      bytes = new Uint8Array(source.byteLength);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < source.length; i++) {
        if (encoding === "f32le") view.setFloat32(i * 4, source[i]!, true);
        else view.setUint32(i * 4, source[i]!, true);
      }
    }
    sections.push({ path, encoding, offset, length: bytes.length, sha256: "" });
    planes.push(bytes); offset += bytes.length;
    return [];
  };
  const packet = input.renderPacket.value;
  const geometries = [];
  for (const [index, geometry] of packet.geometries.entries()) {
    const result: Record<string, unknown> = { ...geometry };
    for (const key of ["vertices", "indices", "uv0", "uv1", "tangents", "colors"] as const) {
      const source = geometry[key];
      if (source !== undefined) result[key] = add(`/geometries/${index}/${key}`, source, key === "indices" ? "u32le" : "f32le");
    }
    geometries.push(result);
  }
  const textures = [];
  for (const [index, texture] of (packet.textures ?? []).entries()) {
    const result = { ...texture, data: add(`/textures/${index}/data`, texture.data, "rgba8") };
    if (texture.mipmaps) {
      const mipmaps = [];
      for (const [level, mip] of texture.mipmaps.entries()) mipmaps.push({ ...mip,
        data: add(`/textures/${index}/mipmaps/${level}/data`, mip.data, "rgba8") });
      Object.assign(result, { mipmaps });
    }
    textures.push(result);
  }
  const { objectBindings: _bindings, ...metadata } = packet;
  const binaryPacket = { ...metadata, geometries, textures,
    instances: packet.instances.map(instance => ({ ...instance, transform: Array.from(instance.transform) })) };
  const draft = createOwnedRuntimePackageCore(input, binaryPacket), resources: RuntimeResourceIndexEntry[] = [], hashes = new Map<string, string>();
  offset = 0;
  for (const [index, plane] of planes.entries()) {
    signal?.throwIfAborted();
    if (plane.length >= 64 * 1024 && typeof CompressionStream !== "undefined") {
      const stream = new Blob([plane]).stream().pipeThrough(new CompressionStream("deflate"));
      const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
      signal?.throwIfAborted();
      if (compressed.length < plane.length) {
        planes[index] = compressed;
        Object.assign(sections[index]!, { compression: "deflate", decodedLength: plane.length, length: compressed.length });
      }
    }
    sections[index]!.offset = offset; offset += planes[index]!.length;
    sections[index]!.sha256 = await sha256(planes[index]!);
  }
  for (const resource of draft.resources) {
    const value = resource.kind === "render-packet" ? { metadata: draft.payloads[resource.id]!, sections } : draft.payloads[resource.id]!;
    const hash = await hashOwnedRuntimeJson(value as unknown as RuntimeJson, signal);
    hashes.set(resource.id, hash); resources.push({ ...resource, contentHash: { algorithm: "sha256", value: hash } });
  }
  const core = { ...draft, resources }, packageHash = await hashOwnedRuntimeJson(core as unknown as RuntimeJson, signal);
  const runtimePackage = validateOwnedBuiltRuntimePackage({ ...core, packageHash: { algorithm: "sha256", value: packageHash } },
    { packageHash, resources: hashes, binaryRenderValidated: true });
  const packageJson = orderedRuntimeJson({ schema: "deep-engine.runtime-transfer", version: 1, envelope: runtimePackage, sections } as unknown as RuntimeJson);
  const header = new TextEncoder().encode(packageJson);
  requireValue(header.length <= MAX_HEADER && 12 + header.length + offset <= MAX_BYTES, "$", "Binary runtime exceeds its header or input budget.");
  const packageBytes = new Uint8Array(12 + header.length + offset);
  packageBytes.set(new TextEncoder().encode(RUNTIME_BINARY_MAGIC));
  new DataView(packageBytes.buffer).setUint32(8, header.length, true);
  packageBytes.set(header, 12);
  for (const [index, plane] of planes.entries()) packageBytes.set(plane, 12 + header.length + sections[index]!.offset);
  signal?.throwIfAborted();
  return { runtimePackage, packageJson, packageBytes };
}
