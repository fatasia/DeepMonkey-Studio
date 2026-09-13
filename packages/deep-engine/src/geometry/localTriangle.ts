import { MeshletError } from "./types.js";

export function packLocalTriangle(a: number, b: number, c: number): number {
  for (const value of [a, b, c]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xff) {
      throw new MeshletError("invalid-input", "Local meshlet indices must fit in eight bits.");
    }
  }
  return (a | (b << 8) | (c << 16)) >>> 0;
}

export function unpackLocalTriangle(packed: number): readonly [number, number, number] {
  if (!Number.isSafeInteger(packed) || packed < 0 || packed > 0x00ff_ffff) {
    throw new MeshletError("invalid-input", "Packed local triangle must use only its low 24 bits.");
  }
  return [packed & 0xff, (packed >>> 8) & 0xff, (packed >>> 16) & 0xff];
}
