/** Validate source-file-local identity metadata, not geometric accuracy. */
export function auditXtSourceMapJson(json) {
  const faces = new Map();
  const bodies = new Set();
  let primitiveCount = 0;
  let triangles = 0;
  if (!Array.isArray(json.meshes) || json.meshes.length === 0) throw new Error('No mapped meshes');
  for (const mesh of json.meshes) {
    if (!Array.isArray(mesh.primitives) || mesh.primitives.length === 0) throw new Error('Empty mapped mesh');
    for (const primitive of mesh.primitives) {
      const map = primitive.extras?.bimSourceMap;
      const count = json.accessors?.[primitive.indices]?.count;
      if (!map || map.schemaVersion !== 1 || map.scope !== 'source-file-local' || map.format !== 'X_T'
        || !validHandle(map.body) || primitive.mode !== 4 || !Number.isSafeInteger(count)
        || count <= 0 || count % 3 !== 0 || !Array.isArray(map.faceRanges)) throw new Error('Invalid source map contract');
      let covered = 0;
      for (const range of map.faceRanges) {
        if (!Array.isArray(range) || range.length !== 3) throw new Error('Invalid face range');
        const [start, length, face] = range;
        if (start !== covered || !Number.isSafeInteger(start) || !Number.isSafeInteger(length)
          || length <= 0 || length > count / 3 - covered || !validHandle(face)) throw new Error('Invalid face range coverage');
        if (faces.has(face) && faces.get(face) !== map.body) throw new Error('Source face belongs to multiple bodies');
        faces.set(face, map.body);
        covered += length;
      }
      if (covered !== count / 3) throw new Error('Unmapped triangles');
      bodies.add(map.body);
      primitiveCount += 1;
      triangles += covered;
    }
  }
  return { bodies: bodies.size, uniqueFaces: faces.size, primitiveCount, triangles };
}

function validHandle(value) { return typeof value === 'string' && /^[1-9][0-9]*$/.test(value); }

export function auditXtGlbSourceMap(bytes) {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2
    || bytes.readUInt32LE(8) !== bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a) throw new Error('Invalid GLB framing');
  const length = bytes.readUInt32LE(12);
  if (length % 4 !== 0 || length > bytes.length - 20) throw new Error('Invalid GLB JSON length');
  return auditXtSourceMapJson(JSON.parse(bytes.subarray(20, 20 + length).toString('utf8')));
}
