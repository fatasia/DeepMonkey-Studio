import { createRequire } from 'node:module';
import { createIndexedTrianglePrimitive } from '../../apps/api/src/indexedTriangleMesh.ts';
import { completePlanarBrepParts } from './3dm-planar-trim.mts';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { Document, NodeIO } = require('@gltf-transform/core');

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

/** Research adapter only: source mesh buffers are shared by instance nodes. */
export async function export3dmGlb(source: any, sourceSha256: string) {
  check(source.schemaVersion === 1 && /^[a-f0-9]{64}$/.test(sourceSha256), 'invalid source contract');
  check(Number.isFinite(source.metersPerUnit) && source.metersPerUnit > 0, 'invalid units');
  const objects = new Map<string, any>();
  const definitions = new Map<string, any>();
  for (const object of source.objects) {
    check(uuid.test(object.id) && !objects.has(object.id), 'invalid or duplicate object identity');
    objects.set(object.id, object);
  }
  for (const definition of source.definitions) {
    check(uuid.test(definition.id) && !definitions.has(definition.id), 'invalid or duplicate definition identity');
    check(Array.isArray(definition.members) && new Set(definition.members).size === definition.members.length, 'duplicate definition member');
    definitions.set(definition.id, definition);
  }
  const document = new Document();
  const buffer = document.createBuffer('3DM source meshes');
  const scene = document.createScene('3DM research');
  document.getRoot().setDefaultScene(scene);
  // Rhino coordinates are Z-up. Keep source-local buffers and convert only at the root.
  const root = document.createNode('3DM source coordinates').setScale(Array(3).fill(source.metersPerUnit))
    .setRotation([-Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
  scene.addChild(root);
  const diagnostics: any[] = [];
  const meshes = new Map<string, any>();
  const sourceMap = (object: any) => ({ scope: 'source-file-local', format: '3DM', sourceSha256,
    objectId: object.id, layerIndex: object.layerIndex, materialIndex: object.materialIndex,
    materialSource: object.materialSource });
  for (const object of objects.values()) {
    check(source.layers.some((layer: any) => layer.index === object.layerIndex), 'missing layer');
    const completed = completePlanarBrepParts(object);
    const parts = object.kind === 'mesh' ? [{ face: null, mesh: object.mesh }] : completed.parts;
    diagnostics.push(...completed.diagnostics);
    if (object.kind === 'brep' && parts.length < object.faceCount) diagnostics.push({ objectId: object.id, code: 'missing-brep-render-mesh', count: object.faceCount - parts.length });
    if (object.kind === 'unsupported') diagnostics.push({ objectId: object.id, code: 'unsupported-object', objectType: object.objectType });
    if (!parts.length) continue;
    const mesh = document.createMesh(object.id).setExtras(sourceMap(object));
    for (const part of parts) {
      const m = part.mesh;
      check(m.positions.length > 0 && m.positions.every((p: any) => Array.isArray(p) && p.length === 3 && p.every((n: number) => Number.isFinite(n) && Number.isFinite(Math.fround(n)))), 'invalid positions');
      check(m.triangles.length > 0 && m.triangles.length === m.sourceFaceCount + m.quadCount, 'invalid triangle count');
      check(m.triangles.every((t: any) => Array.isArray(t) && t.length === 3 && new Set(t).size === 3 && t.every((i: number) => Number.isInteger(i) && i >= 0 && i < m.positions.length)), 'invalid indices');
      const normals = m.normals ?? [], uv = m.textureCoordinates ?? [];
      const vectors = (values: any, width: number) => Array.isArray(values) && (!values.length || values.length === m.positions.length)
        && values.every((v: any) => Array.isArray(v) && v.length === width && v.every((n: number) => Number.isFinite(n) && Number.isFinite(Math.fround(n))));
      check(vectors(normals, 3) && normals.every((n: number[]) => Math.abs(Math.hypot(...n) - 1) < 1e-4), 'invalid source normals');
      check(vectors(uv, 2) && (!uv.length || m.textureCoordinateSource === 'ON_Mesh.m_T'), 'invalid source UV');
      // No material appearance is inferred from identity-only source metadata.
      const primitive = createIndexedTrianglePrimitive(document, buffer, null as any, {
        positions: m.positions.flat(), indices: m.triangles.flat(), normals: normals.flat(),
      }).setExtras({ ...sourceMap(object), brepFaceIndex: part.face,
        geometrySource: part.geometrySource ?? 'source-stored-mesh', tessellationAudit: part.audit ?? null,
        textureCoordinateSource: uv.length ? m.textureCoordinateSource : null });
      if (uv.length) primitive.setAttribute('TEXCOORD_0', document.createAccessor().setType('VEC2')
        .setArray(new Float32Array(uv.flat())).setBuffer(buffer));
      mesh.addPrimitive(primitive);
    }
    meshes.set(object.id, mesh);
  }
  const checked = new Set<string>();
  const validate = (id: string, path = new Set<string>()) => {
    check(!path.has(id), 'instance cycle');
    check(path.size < 128, 'instance depth budget');
    if (checked.has(id)) return;
    const definition = definitions.get(id); check(definition, 'missing instance definition');
    for (const member of definition.members) {
      const object = objects.get(member); check(object?.definitionMember, 'missing definition member');
      if (object.kind === 'instance') validate(object.definitionId, new Set([...path, id]));
    }
    checked.add(id);
  };
  for (const id of definitions.keys()) validate(id);
  let nodeCount = 0;
  const instantiate = (object: any, parent: any) => {
    check(++nodeCount <= 100000, 'instance expansion budget');
    const node = document.createNode(object.id).setExtras(sourceMap(object)); parent.addChild(node);
    if (meshes.has(object.id)) node.setMesh(meshes.get(object.id));
    if (object.kind === 'instance') {
      const definition = definitions.get(object.definitionId); check(definition, 'missing instance definition');
      const m = object.matrixRowMajor;
      check(Array.isArray(m) && m.length === 16 && m.every(Number.isFinite) && m[12] === 0 && m[13] === 0 && m[14] === 0 && m[15] === 1, 'invalid instance matrix');
      const columnMajor = m.map((_: number, i: number) => m[(i % 4) * 4 + Math.floor(i / 4)]);
      node.setMatrix(columnMajor);
      check(node.getMatrix().every((n: number, i: number) => Number.isFinite(n) && Math.abs(n - columnMajor[i]) <= 1e-8 * Math.max(1, Math.abs(columnMajor[i]))), 'unsupported sheared or singular instance matrix');
      node.setExtras({ ...sourceMap(object), definitionId: object.definitionId, sourceMatrixRowMajor: m });
      for (const member of definition.members) instantiate(objects.get(member), node);
    }
  };
  for (const object of objects.values()) if (!object.definitionMember) instantiate(object, root);
  const rendered = document.getRoot().listNodes().filter((node: any) => node.getMesh());
  const usedMeshes = new Set(rendered.map((node: any) => node.getMesh()));
  for (const mesh of meshes.values()) if (!usedMeshes.has(mesh)) mesh.dispose();
  const missingBrepGeometry = diagnostics.some(row => row.code === 'missing-brep-render-mesh');
  const sidecar = { schemaVersion: 1, scope: 'source-file-local', format: '3DM', sourceSha256,
    unitSystem: source.unitSystem, metersPerUnit: source.metersPerUnit, coordinates: 'source-Z-up; GLB-root-Y-up-meters',
    objects: source.objects.map(({ mesh, storedRenderMeshes, ...metadata }: any) => metadata),
    definitions: source.definitions, layers: source.layers, materials: source.materials, diagnostics,
    status: rendered.length ? (missingBrepGeometry ? 'partial-geometry-preview' : 'geometry-preview') : 'inspect-no-geometry' };
  if (!rendered.length) return { bytes: null, sidecar };
  // Texture paths are source metadata only, never external GLB image URIs.
  root.setExtras({ sourceSha256, sourceFormat: '3DM', diagnostics, sourceMaterials: source.materials });
  return { bytes: await new NodeIO().writeBinary(document), sidecar };
}
