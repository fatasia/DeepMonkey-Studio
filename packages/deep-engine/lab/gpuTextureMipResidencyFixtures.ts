import {
  prepareRenderPacket,
  type DecodedTexture,
  type GeometryResource,
  type PreparedPacket,
} from "@bim-studio/deep-engine";

export const RGBA_TEXTURE_ID = "deep-mip-rgba";
export const BC1_TEXTURE_ID = "deep-mip-bc1";
export const RGBA_EXPECTED = Object.freeze({
  1: Object.freeze([0, 255, 0, 255] as const),
  2: Object.freeze([0, 0, 255, 255] as const),
});
export const BC1_EXPECTED = Object.freeze([
  Object.freeze([0, 255, 0, 255] as const),
  Object.freeze([0, 0, 255, 255] as const),
  Object.freeze([255, 0, 0, 255] as const),
]);

const GEOMETRY: GeometryResource = Object.freeze({
  id: "deep-mip-geometry",
  revision: 1,
  vertices: new Float32Array([
    -1, -1, 0, 0, 0, 1,
    3, -1, 0, 0, 0, 1,
    -1, 3, 0, 0, 0, 1,
  ]),
  uv0: new Float32Array([0, 0, 2, 0, 0, 2]),
  indices: new Uint32Array([0, 1, 2]),
});

export function rgbaMipPacket(): PreparedPacket {
  const texture: DecodedTexture = {
    id: RGBA_TEXTURE_ID,
    revision: 1,
    semantic: "baseColor",
    width: 4,
    height: 4,
    data: rgbaPixels(4, 4, [255, 0, 0, 255]),
    mipmaps: [
      { width: 2, height: 2, data: rgbaPixels(2, 2, RGBA_EXPECTED[1]) },
      { width: 1, height: 1, data: rgbaPixels(1, 1, RGBA_EXPECTED[2]) },
    ],
    sampler: { addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
      magFilter: "nearest", minFilter: "nearest", mipmapFilter: "nearest" },
  };
  return packet(texture);
}

export function bc1MipPacket(): PreparedPacket {
  const texture: DecodedTexture = {
    id: BC1_TEXTURE_ID,
    revision: 1,
    semantic: "baseColor",
    compression: "bc1-rgba",
    width: 8,
    height: 8,
    data: repeatedBlock(bc1Block(0xf800, 0x07e0), 4),
    mipmaps: [
      { width: 4, height: 4, data: bc1Block(0x07e0, 0x001f) },
      { width: 2, height: 2, data: bc1Block(0x001f, 0x0000) },
      { width: 1, height: 1, data: bc1Block(0xf800, 0x07e0) },
    ],
    sampler: { addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
      magFilter: "nearest", minFilter: "nearest", mipmapFilter: "nearest" },
  };
  return packet(texture);
}

function packet(texture: DecodedTexture): PreparedPacket {
  return prepareRenderPacket({
    geometries: [GEOMETRY],
    textures: [texture],
    materials: [{ id: "deep-mip-material", baseColor: [1, 1, 1], metallic: 0, roughness: 1,
      baseColorTexture: { texture: texture.id } }],
    instances: [{ id: "deep-mip-instance", geometry: GEOMETRY.id, material: "deep-mip-material",
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
  });
}

function rgbaPixels(width: number, height: number, color: readonly number[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < result.length; offset += 4) result.set(color, offset);
  return result;
}

function bc1Block(color0: number, color1: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([color0 & 255, color0 >>> 8, color1 & 255, color1 >>> 8, 0, 0, 0, 0]);
}

function repeatedBlock(block: Uint8Array<ArrayBuffer>, count: number): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(block.byteLength * count);
  for (let index = 0; index < count; index += 1) result.set(block, index * block.byteLength);
  return result;
}
