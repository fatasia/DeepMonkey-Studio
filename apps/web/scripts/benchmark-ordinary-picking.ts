import * as THREE from "three";
import { writeFileSync } from "node:fs";
import { platform, cpus } from "node:os";
import { buildPickingIndex } from "../src/viewer/ordinaryPickingBuild";
import { OrdinaryPicking } from "../src/viewer/ordinaryPicking";

const cases = [{ name: "20k-plane", segments: 100 }, { name: "200k-plane", segments: 316 }, { name: "1m-plane", segments: 707 }, { name: "128k-pipe-knot", segments: 0 }];
const report: object[] = [];
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)]!;
for (const item of cases) {
  const geometry = item.segments ? new THREE.PlaneGeometry(100, 100, item.segments, item.segments) : new THREE.TorusKnotGeometry(25, 8, 1000, 64);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.rotation.set(0.1, 0.2, 0.1); mesh.updateMatrixWorld(true); geometry.computeBoundingSphere();
  const position = (geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
  const index = geometry.index!.array as Uint16Array | Uint32Array;
  const copyStart = performance.now(); const snapshot = { position: position.slice(), index: index.slice(), start: 0, count: Infinity }; const copyMs = performance.now() - copyStart;
  const buildStart = performance.now(); const serialized = buildPickingIndex(snapshot); const buildMs = performance.now() - buildStart;
  const casters = Array.from({ length: 160 }, (_, i) => new THREE.Raycaster(new THREE.Vector3(((i * 37) % 87) - 43.123, ((i * 23) % 79) - 39.234, 110), new THREE.Vector3(0, 0, -1)));
  const roots = [mesh];
  const picker = new OrdinaryPicking({ builder: { build: async () => serialized, dispose() {} } });
  picker.intersectObjects(casters[0]!, roots);
  while (picker.diagnostics().building) await new Promise(resolve => setTimeout(resolve, 1));
  if (picker.diagnostics().ready !== 1) throw new Error("Fixture index not ready");
  const measure = (accelerated: boolean) => casters.map(caster => {
    const start = performance.now(); if (accelerated) picker.intersectObjects(caster, roots); else caster.intersectObjects(roots, true); return performance.now() - start;
  });
  // 预热后交替测量原路径与索引，避免只把 JIT/冷启动成本记在其中一侧。
  measure(false); measure(true);
  const ordinary: number[] = []; const accelerated: number[] = [];
  for (let round = 0; round < 3; round++) {
    if (round % 2) { accelerated.push(...measure(true)); ordinary.push(...measure(false)); }
    else { ordinary.push(...measure(false)); accelerated.push(...measure(true)); }
  }
  const mismatches = casters.filter(caster => {
    const original = caster.intersectObjects(roots, true)[0];
    const optimized = picker.intersectObjects(caster, roots)[0];
    return original?.faceIndex !== optimized?.faceIndex || Boolean(original) !== Boolean(optimized) || (original && optimized && Math.abs(original.distance - optimized.distance) > 1e-8);
  }).length;
  report.push({ case: item.name, triangles: index.length / 3, rays: ordinary.length, copyMs, buildMs, snapshotBytes: position.byteLength + index.byteLength,
    indexBytes: serialized.roots.reduce((sum, value) => sum + value.byteLength, 0) + (serialized.indirectBuffer?.byteLength ?? 0),
    ordinaryP50Ms: percentile(ordinary, 0.5), ordinaryP95Ms: percentile(ordinary, 0.95), acceleratedP50Ms: percentile(accelerated, 0.5), acceleratedP95Ms: percentile(accelerated, 0.95),
    speedupP50: percentile(ordinary, 0.5) / percentile(accelerated, 0.5), mismatches });
  picker.dispose(); geometry.dispose(); mesh.material.dispose();
}
const evidence = { createdAt: new Date().toISOString(), node: process.version, platform: platform(), cpu: cpus()[0]?.model, three: THREE.REVISION,
  note: "真实 Three CPU 拾取微基准；加速计时含生产 OrdinaryPicking 遍历/资格与版本校验/排序；建树函数与 Worker 相同，建树计时不含浏览器 Worker 启动/消息；不代表整站 FPS 或任意客户模型", report };
if (process.argv[2]) writeFileSync(process.argv[2], `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
