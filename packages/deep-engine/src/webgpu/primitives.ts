export interface MeshData {
  readonly vertices: Float32Array<ArrayBuffer>;
  readonly indices: Uint32Array<ArrayBuffer>;
}

export function sphereMesh(segments = 40, rings = 24): MeshData {
  if (!Number.isInteger(segments) || !Number.isInteger(rings) || segments < 3 || rings < 2 || segments > 256 || rings > 256) {
    throw new Error("Sphere subdivisions are outside the supported range.");
  }
  const vertices: number[] = [], indices: number[] = [];
  for (let y = 0; y <= rings; y++) for (let x = 0; x <= segments; x++) {
    const theta = y / rings * Math.PI, phi = x / segments * Math.PI * 2;
    const nx = Math.sin(theta) * Math.cos(phi), ny = Math.cos(theta), nz = Math.sin(theta) * Math.sin(phi);
    vertices.push(nx, ny, nz, nx, ny, nz);
  }
  for (let y = 0; y < rings; y++) for (let x = 0; x < segments; x++) {
    const a = y * (segments + 1) + x, b = a + segments + 1;
    if (y > 0) indices.push(a, a + 1, b);
    if (y < rings - 1) indices.push(a + 1, b + 1, b);
  }
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

export function groundMesh(): MeshData {
  return {
    vertices: new Float32Array([-1, 0, -1, 0, 1, 0, -1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, -1, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}
