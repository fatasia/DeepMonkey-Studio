import { Document, NodeIO } from '@gltf-transform/core';
import { createIndexedTrianglePrimitive } from './indexedTriangleMesh.js';
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function indexed(rows: any[], name: string) {
  check(Array.isArray(rows) && rows.length <= 100000, `${name}: collection budget`);
  const result = new Map<string, any>();
  for (const row of rows) { check(row && typeof row.id === 'string' && row.id && !result.has(row.id), `${name}: duplicate/missing identity`); result.set(row.id, row); }
  return result;
}

/** 只转存解出的真实显示网格；未知面归属保留，不能升级为完整 B-Rep。 */
export async function exportSldprtPreview(ir: any, report: any, sourceSha256: string) {
  check(ir?.ir_version === '6' && ir.units?.length === 'millimeter' && /^[a-f0-9]{64}$/.test(sourceSha256), 'unsupported CADIR profile or units');
  const decoded = report?.decode_report;
  check(decoded?.format === 'sldprt' && decoded.geometry_transferred === true && decoded.container_only === false, 'not a geometry decode');
  check(ir.model && Array.isArray(ir.model.configurations) && ir.model.configurations.length <= 100000, 'invalid configuration collection');
  check(ir.model.configurations.every((entry: any) => entry && (entry.active === undefined || typeof entry.active === 'boolean')), 'invalid configuration');
  const active = ir.model.configurations.filter((entry: any) => entry.active === true);
  check(active.length === 1 && Array.isArray(active[0].bodies), 'multiple or unresolved active configurations require explicit selection');
  const bodies = indexed(ir.model.bodies, 'bodies'), faces = indexed(ir.model.faces, 'faces');
  const tessellations = indexed(ir.model.tessellations, 'tessellations');
  const activeBodies = new Set(active[0].bodies);
  check(activeBodies.size === active[0].bodies.length && bodies.size === activeBodies.size
    && [...bodies.keys()].every(id => activeBodies.has(id)), 'IR bodies do not match active configuration');
  const appearances = indexed(ir.model.appearances, 'appearances');
  check(Array.isArray(ir.model.appearance_bindings) && ir.model.appearance_bindings.length <= 100000, 'appearance binding budget');
  const bindingByMesh = new Map<string, string>();
  for (const entry of ir.model.appearance_bindings) {
    check(entry?.target && typeof entry.target.kind === 'string', 'invalid appearance binding');
    if (entry.target.kind !== 'tessellation') continue;
    check(tessellations.has(entry.target.id) && !bindingByMesh.has(entry.target.id), 'ambiguous or unknown appearance target');
    check(appearances.has(entry.appearance), 'missing appearance');
    bindingByMesh.set(entry.target.id, entry.appearance);
  }
  check(decoded.losses === undefined || Array.isArray(decoded.losses) && decoded.losses.length <= 100000, 'invalid decode diagnostics');
  check(report.check_report === undefined || Array.isArray(report.check_report?.findings) && report.check_report.findings.length <= 100000, 'invalid check diagnostics');
  check(tessellations.size > 0 && !(ir.model.occurrences?.length), 'empty display geometry or unsupported assembly');
  const document = new Document(), buffer = document.createBuffer('SLDPRT display mesh');
  const scene = document.createScene('SLDPRT diagnostic preview'); document.getRoot().setDefaultScene(scene);
  const root = document.createNode('source millimeters').setScale([0.001, 0.001, 0.001]); scene.addChild(root);
  const bodyNodes = new Map<string, any>();
  for (const body of bodies.values()) { const node = document.createNode(body.id).setExtras({ sourceBodyId: body.id }); root.addChild(node); bodyNodes.set(body.id, node); }
  const diagnostics: any[] = [...(decoded.losses ?? []), ...(report.check_report?.findings ?? [])], sourceMap: any[] = [];
  let vertices = 0, triangles = 0, maximumFloat32ErrorMm = 0;
  for (const row of tessellations.values()) {
    const positions = row.vertices, indices = row.triangles;
    check(Array.isArray(positions) && positions.length > 0 && Array.isArray(indices) && indices.length > 0, 'empty tessellation');
    vertices += positions.length; triangles += indices.length;
    check(vertices <= 10000000 && triangles <= 20000000, 'display geometry budget');
    const flat = positions.flatMap((point: any) => {
      const xyz = [point.x, point.y, point.z];
      check(xyz.every(value => typeof value === 'number' && Number.isFinite(value) && Number.isFinite(Math.fround(value))), 'invalid position');
      maximumFloat32ErrorMm = Math.max(maximumFloat32ErrorMm, Math.hypot(...xyz.map(value => value - Math.fround(value))));
      return xyz;
    });
    check(indices.every((triangle: any) => Array.isArray(triangle) && triangle.length === 3 && new Set(triangle).size === 3
      && triangle.every((i: number) => Number.isSafeInteger(i) && i >= 0 && i < positions.length)), 'invalid triangle index');
    check(row.body === undefined || bodies.has(row.body), 'unknown source body');
    check(row.faces === undefined || Array.isArray(row.faces) && row.faces.every((id: string) => faces.has(id)), 'unknown source face');
    const normals = row.normals ?? [];
    check(normals.length === positions.length && normals.every((n: any) => [n.x, n.y, n.z].every(Number.isFinite)
      && Math.abs(Math.hypot(n.x, n.y, n.z) - 1) < 1e-4), 'invalid or missing source normals');
    const appearance = appearances.get(bindingByMesh.get(row.id) ?? '');
    const c = appearance?.base_color;
    const rgba: [number, number, number, number] = c ? [c.r, c.g, c.b, c.a] : [1, 1, 1, 1];
    check(rgba.every(value => Number.isFinite(value) && value >= 0 && value <= 1), 'invalid base color');
    const material = document.createMaterial(appearance?.id ?? 'unassigned').setBaseColorFactor(rgba).setMetallicFactor(0).setRoughnessFactor(1);
    if (rgba[3] < 1) material.setAlphaMode('BLEND');
    const mapping = { sourceSha256, sourceTessellationId: row.id, sourceBodyId: row.body ?? null, sourceFaceIds: row.faces ?? [],
      sourceAppearanceId: appearance?.id ?? null, geometrySource: 'source-display-mesh', vertexCount: positions.length, triangleCount: indices.length };
    const primitive = createIndexedTrianglePrimitive(document, buffer, material, { positions: flat, indices: indices.flat(),
      normals: normals.flatMap((n: any) => [n.x, n.y, n.z]) }).setExtras(mapping);
    const node = document.createNode(row.id).setMesh(document.createMesh(row.id).addPrimitive(primitive)).setExtras(mapping);
    (row.body ? bodyNodes.get(row.body) : root).addChild(node);
    if (!row.body || !row.faces?.length) diagnostics.push({ code: 'display-face-ownership-unresolved', sourceTessellationId: row.id });
    sourceMap.push(mapping);
  }
  check(maximumFloat32ErrorMm <= 0.01, 'Float32 conversion exceeds 0.01 mm');
  const sidecar = { schemaVersion: 1, status: 'partial-geometry-preview', sourceFormat: 'SLDPRT', sourceSha256,
    sourceLengthUnit: 'millimeter', metersPerUnit: 0.001, axisPolicy: 'source-axes-preserved; orientation-not-certified',
    materialPolicy: 'decoded-base-color; neutral-roughness-metalness; textures-not-transferred', vertices, triangles,
    maximumFloat32ErrorMm, configuration: { id: active[0].id, name: active[0].name }, diagnostics, sourceMap };
  root.setExtras({ sourceSha256, quality: sidecar.status });
  return { bytes: await new NodeIO().writeBinary(document), sidecar };
}
