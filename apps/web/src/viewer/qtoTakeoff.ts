import * as THREE from "three";

// P7 工程量与测量深化·切片一（2026-09-19 用户批准的轻量切片）：
// 从构件几何直接估算体积/表面积，并按类别×楼层聚合成 QTO 清单行。
// 体积用带符号四面体法（对封闭实体精确）；表面积用三角形叉积（总是有效）。
// source map（C08）保证口径可审计；非封闭网格的体积如实不可靠——见 evidenceBoundary。

export interface QuantityEstimate {
  objectId: string;
  /** 封闭实体网格的实体体积（m³，按世界尺度）；含开放网格时该值不可信，见 openMeshSuspected */
  volumeCubicMetres: number;
  surfaceAreaSquareMetres: number;
  meshCount: number;
  openMeshSuspected: boolean;
}

export interface QtoObjectInput {
  id: string;
  root: THREE.Object3D;
  category: string;
  level: string;
}

export interface QtoLine {
  category: string;
  level: string;
  count: number;
  totalVolumeCubicMetres: number;
  totalSurfaceAreaSquareMetres: number;
  openMeshSuspectedCount: number;
}

export interface QtoReport {
  generatedAt: string;
  objectCount: number;
  lines: QtoLine[];
  skipped: Array<{ id: string; reason: string }>;
  totals: { volumeCubicMetres: number; surfaceAreaSquareMetres: number };
  evidenceBoundary: "体积仅对封闭实体网格精确（带符号四面体法），开放网格行已用 openMeshSuspected 标记；面积总是有效；单位为世界坐标单位的三次/二次方";
}

const CLOSED_VOLUME_EPSILON_RATIO = 0.2;

export function estimateObjectQuantity(id: string, root: THREE.Object3D): QuantityEstimate | null {
  root.updateWorldMatrix(true, true);
  let volume = 0;
  let area = 0;
  let meshCount = 0;
  let openMeshSuspected = false;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    const position = geometry?.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!geometry || !position) return;
    if (child.visible === false) return;
    meshCount += 1;
    const index = geometry.getIndex();
    const triangleCount = index ? index.count / 3 : position.count / 3;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const tetra = new THREE.Vector3();
    const edgeAB = new THREE.Vector3();
    const edgeAC = new THREE.Vector3();
    let meshVolume = 0;
    let meshArea = 0;
    const matrix = mesh.matrixWorld;
    for (let t = 0; t < triangleCount; t += 1) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(position, i0).applyMatrix4(matrix);
      b.fromBufferAttribute(position, i1).applyMatrix4(matrix);
      c.fromBufferAttribute(position, i2).applyMatrix4(matrix);
      // tetra/edgeAB/edgeAC 为独立临时量：Vector3.cross 原地修改自身，
      // 直接写 a.dot(b.cross(c)) 会破坏 b 并污染面积计算（已被单测抓出）。
      meshVolume += a.dot(tetra.copy(b).cross(c)) / 6;
      edgeAB.copy(b).sub(a);
      edgeAC.copy(c).sub(a);
      meshArea += edgeAB.cross(edgeAC).length() / 2;
    }
    volume += meshVolume;
    area += meshArea;
    // 开放网格的带符号体积显著偏离同表面积封闭体（|V| ≤ S·t/6 的粗糙上界反推不可靠），
    // 用保守启发式：|V| 六倍小于 S²/（12π）（同面积球体积）的 20% 视为疑似开放，只做标记不做裁决。
    const sameAreaSphereVolume = (meshArea * meshArea) / (12 * Math.PI);
    openMeshSuspected = openMeshSuspected || (Math.abs(meshVolume) < CLOSED_VOLUME_EPSILON_RATIO * sameAreaSphereVolume && meshArea > 1e-9);
  });
  if (meshCount === 0) return null;
  return {
    objectId: id,
    volumeCubicMetres: Number(Math.abs(volume).toFixed(6)),
    surfaceAreaSquareMetres: Number(area.toFixed(6)),
    meshCount,
    openMeshSuspected,
  };
}

export function buildQtoReport(objects: QtoObjectInput[]): QtoReport {
  const generatedAt = new Date().toISOString();
  const lines = new Map<string, QtoLine>();
  const skipped: Array<{ id: string; reason: string }> = [];
  let totalVolume = 0;
  let totalArea = 0;

  for (const object of objects) {
    const estimate = estimateObjectQuantity(object.id, object.root);
    if (!estimate) {
      skipped.push({ id: object.id, reason: "无可见网格" });
      continue;
    }
    const key = `${object.category}∥${object.level}`;
    let line = lines.get(key);
    if (!line) {
      line = { category: object.category, level: object.level, count: 0, totalVolumeCubicMetres: 0, totalSurfaceAreaSquareMetres: 0, openMeshSuspectedCount: 0 };
      lines.set(key, line);
    }
    line.count += 1;
    line.totalVolumeCubicMetres += estimate.volumeCubicMetres;
    line.totalSurfaceAreaSquareMetres += estimate.surfaceAreaSquareMetres;
    if (estimate.openMeshSuspected) line.openMeshSuspectedCount += 1;
    totalVolume += estimate.volumeCubicMetres;
    totalArea += estimate.surfaceAreaSquareMetres;
  }

  return {
    generatedAt,
    objectCount: objects.length,
    lines: [...lines.values()].map((line) => ({
      ...line,
      totalVolumeCubicMetres: Number(line.totalVolumeCubicMetres.toFixed(6)),
      totalSurfaceAreaSquareMetres: Number(line.totalSurfaceAreaSquareMetres.toFixed(6)),
    })),
    skipped,
    totals: {
      volumeCubicMetres: Number(totalVolume.toFixed(6)),
      surfaceAreaSquareMetres: Number(totalArea.toFixed(6)),
    },
    evidenceBoundary: "体积仅对封闭实体网格精确（带符号四面体法），开放网格行已用 openMeshSuspected 标记；面积总是有效；单位为世界坐标单位的三次/二次方",
  };
}
