import { auditXtGlbSourceMap } from './xtGlbSourceMap.mjs';

/** Unquantized primitive-local geometry only; world transforms are a separate audit. */
export function mappedFaceGeometry(bytes) {
  auditXtGlbSourceMap(bytes);
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  const header = 20 + jsonLength;
  if (header + 8 > bytes.length || bytes.readUInt32LE(header + 4) !== 0x004e4942
    || header + 8 + bytes.readUInt32LE(header) !== bytes.length) throw new Error('Missing GLB BIN');
  const bin = bytes.subarray(header + 8);
  function accessor(id, type, components) {
    const a = json.accessors?.[id], v = json.bufferViews?.[a?.bufferView];
    const size = { 5123: 2, 5125: 4, 5126: 4 }[a?.componentType];
    if (!a || a.type !== type || a.sparse || a.normalized || !v || v.buffer !== 0 || !size
      || !Number.isSafeInteger(a.count) || a.count < 1 || v.extensions) throw new Error('Unsupported accessor');
    const offset = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const stride = v.byteStride ?? size * components;
    if (![offset, stride, v.byteLength, a.byteOffset ?? 0].every(Number.isSafeInteger)
      || offset < 0 || stride < size * components || stride % size !== 0
      || (a.byteOffset ?? 0) < 0 || (a.byteOffset ?? 0) + (a.count - 1) * stride + size * components > v.byteLength
      || (v.byteOffset ?? 0) + v.byteLength > bin.length) throw new Error('Accessor exceeds BIN');
    return { a, at: i => {
      if (!Number.isSafeInteger(i) || i < 0 || i >= a.count) throw new Error('Index outside POSITION');
      return Array.from({ length: components }, (_, c) => {
        const p = offset + i * stride + c * size;
        return a.componentType === 5126 ? bin.readFloatLE(p) : size === 2 ? bin.readUInt16LE(p) : bin.readUInt32LE(p);
      });
    } };
  }
  const faces = new Map();
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
    if (primitive.extensions) throw new Error('Compressed primitive unsupported');
    const p = accessor(primitive.attributes.POSITION, 'VEC3', 3);
    const indices = accessor(primitive.indices, 'SCALAR', 1);
    if (p.a.componentType !== 5126 || ![5123, 5125].includes(indices.a.componentType)) throw new Error('Position/index component type');
    const source = primitive.extras.bimSourceMap;
    for (const [start, length, face] of source.faceRanges) {
      const key = `${source.body}/${face}`;
      const geometry = faces.get(key) ?? { points: [], triangles: [] };
      const points = geometry.points;
      const seen = new Set();
      for (let i = start * 3; i < (start + length) * 3; i++) {
        const index = indices.at(i)[0];
        if (seen.has(index)) continue;
        seen.add(index);
        const point = p.at(index);
        if (!point.every(Number.isFinite)) throw new Error('Non-finite POSITION');
        points.push(point);
      }
      for (let i = start * 3; i < (start + length) * 3; i += 3) {
        geometry.triangles.push([0, 1, 2].map(k => p.at(indices.at(i + k)[0])));
      }
      faces.set(key, geometry);
    }
  }
  return faces;
}

const distance = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));
const sub = (a, b) => a.map((x, i) => x - b[i]);
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function pointTriangleDistance(p, [a, b, c]) {
  const ab = sub(b, a), ac = sub(c, a), q = sub(p, a), n = cross(ab, ac), n2 = dot(n, n);
  if (n2 > 0) {
    const u = dot(cross(q, ac), n) / n2, v = dot(cross(ab, q), n) / n2;
    if (u >= 0 && v >= 0 && u + v <= 1) return Math.abs(dot(q, n)) / Math.sqrt(n2);
  }
  return Math.min(...[[a, b], [a, c], [b, c]].map(([x, y]) => {
    const e = sub(y, x), length = dot(e, e);
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, x), e) / length));
    return distance(p, x.map((v, i) => v + t * e[i]));
  }));
}
function residual(surface, point) {
  const q = point.map((x, i) => x - surface.origin[i]);
  if (surface.kind === 'sphere') return Math.abs(Math.hypot(...q) - surface.radius);
  const length = Math.hypot(...surface.axis);
  if (!(length > 0) || !Number.isFinite(length)) throw new Error('Invalid source axis');
  const n = surface.axis.map(x => x / length);
  const axial = q.reduce((sum, x, i) => sum + x * n[i], 0);
  if (surface.kind === 'plane') return Math.abs(axial);
  if (surface.kind === 'cylinder') return Math.abs(Math.hypot(...q.map((x, i) => x - axial * n[i])) - surface.radius);
  if (surface.kind === 'torus') {
    const radial = Math.hypot(...q.map((x, i) => x - axial * n[i]));
    return Math.abs(Math.hypot(radial - surface.majorRadius, axial) - surface.radius);
  }
  throw new Error('Unsupported surface witness');
}

/** Fixed 10 µm floor plus a declared f32 roundoff budget; vertices, not triangle interiors. */
export function compareFaceWitness(source, points, triangles = []) {
  const validPoint = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
  if (!Array.isArray(points) || !points.length || !points.every(validPoint)
    || !Array.isArray(source.points) || !source.points.every(validPoint)) throw new Error('Invalid face positions');
  if (source.surface && (!validPoint(source.surface.origin)
    || (source.surface.kind !== 'sphere' && !validPoint(source.surface.axis))
    || (source.surface.kind !== 'plane' && !(Number.isFinite(source.surface.radius) && source.surface.radius > 0)))) {
    throw new Error('Invalid source surface');
  }
  if (source.surface?.kind === 'torus'
    && !(Number.isFinite(source.surface.majorRadius) && source.surface.majorRadius > source.surface.radius)) {
    throw new Error('Unsupported torus radii');
  }
  let magnitude = 0;
  for (const p of [...points, ...source.points]) for (const x of p) magnitude = Math.max(magnitude, Math.abs(x));
  const toleranceMm = Math.max(0.01, magnitude * 2 ** -21);
  let boundaryMaxMm = 0;
  for (const witness of source.points) {
    let nearest = Infinity;
    for (const point of points) nearest = Math.min(nearest, distance(witness, point));
    for (const triangle of triangles) {
      // Vertex distance is already an upper bound. Most triangles cannot beat
      // it: reject by their box before allocating projection intermediates.
      let outside = false;
      for (let axis = 0; axis < 3; axis++) {
        const lo = Math.min(triangle[0][axis], triangle[1][axis], triangle[2][axis]);
        const hi = Math.max(triangle[0][axis], triangle[1][axis], triangle[2][axis]);
        if (witness[axis] < lo - nearest || witness[axis] > hi + nearest) { outside = true; break; }
      }
      if (!outside) nearest = Math.min(nearest, pointTriangleDistance(witness, triangle));
    }
    boundaryMaxMm = Math.max(boundaryMaxMm, nearest);
  }
  let surfaceMaxMm = 0;
  if (source.surface) for (const point of points) surfaceMaxMm = Math.max(surfaceMaxMm, residual(source.surface, point));
  const tested = source.points.length > 0 || source.surface !== null;
  return { status: !tested ? 'unresolved' : boundaryMaxMm > toleranceMm || surfaceMaxMm > toleranceMm ? 'mismatch' : 'witness-match',
    boundaryWitnesses: source.points.length, surfaceKind: source.surface?.kind ?? null,
    toleranceMm, boundaryMaxMm, surfaceMaxMm, meshVertices: points.length };
}
