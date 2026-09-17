/** Exact source BODY/FACE ownership; does not prove per-triangle geometric identity. */
export function auditXtSourceIdentity(json, raw) {
  const handle = (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
  if (raw?.schemaVersion !== 1 || !Array.isArray(raw.bodies) || raw.bodies.length === 0) throw new Error('Invalid raw identities');
  const owners = new Map();
  const bodies = new Set();
  for (const row of raw.bodies) {
    if (!handle(row.body) || bodies.has(row.body) || !Array.isArray(row.faces) || row.faces.length === 0) throw new Error('Invalid raw BODY');
    bodies.add(row.body);
    for (const face of row.faces) {
      if (!handle(face) || owners.has(face)) throw new Error('Duplicate or invalid raw FACE');
      owners.set(face, row.body);
    }
  }
  if (!Array.isArray(json?.meshes) || json.meshes.length === 0) throw new Error('Missing mapped meshes');
  const seen = new Set();
  const seenBodies = new Set();
  for (const mesh of json.meshes) {
    if (!Array.isArray(mesh.primitives) || mesh.primitives.length === 0) throw new Error('Missing mapped primitives');
    for (const primitive of mesh.primitives) {
      const map = primitive.extras?.bimSourceMap;
      if (map?.schemaVersion !== 1 || map.scope !== 'source-file-local' || map.format !== 'X_T'
        || !bodies.has(map.body) || !Array.isArray(map.faceRanges) || map.faceRanges.length === 0) throw new Error('Unknown source BODY');
      for (const range of map.faceRanges) {
        if (!Array.isArray(range) || range.length !== 3 || !handle(range[2])) throw new Error('Invalid source FACE range');
        if (owners.get(range[2]) !== map.body) throw new Error('Unknown FACE or wrong BODY ownership');
        seen.add(range[2]);
      }
      seenBodies.add(map.body);
    }
  }
  if (seen.size !== owners.size || seenBodies.size !== bodies.size) throw new Error('Missing source identities');
  return { bodies: bodies.size, uniqueFaces: owners.size };
}
