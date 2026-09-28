/**
 * G1-S1 静态 CAD 夹具（纯 CPU、确定性、零随机源）：法兰盘几何 + 与选层合同同口径的
 * 透视投影矩阵 + 前沿几何展开。为 clusterLodBake/selection/indirectPlan/indirectExecutor
 * 的全链验收提供 ≥4096 三角的静态工业形态输入；不依赖运行时包结构，可被 vitest 与
 * lab 真机探针（clusterLodCadGpuProbe）共同消费（单一来源，防口径分叉）。
 *
 * 投影约定与 clusterLodSilhouette 逐字一致：列主序 mat4，clip = VP·(world,1)，
 * WebGPU 深度 [0,1]，窗口 y 向下。选层相机 viewportHeightPixels 与剪影视口同值，
 * 保证"按像素密度选层"与"剪影像素验收"是同一分辨率口径。
 */

import type { ClusterLodCamera } from "../rayTracing/clusterLodSelection.js";
import { lookAtView, multiplyMatrix, perspectiveProjection } from "./instanceVisibilityReference.js";

/** 夹具三角形预算下限（virtualGeometryPages 分页门槛同值：≥4096 才是页级几何）。 */
export const CLUSTER_LOD_CAD_MIN_TRIANGLES = 4096;
/** 剪影/选层共用视口边长（正方形 → aspect=1）。 */
export const CLUSTER_LOD_CAD_VIEWPORT = 512;
/** 垂直视场角（π/4）；tanHalfFovY = tan(fovY/2) 进选层相机。 */
export const CLUSTER_LOD_CAD_FOV_Y = Math.PI / 4;

export interface ClusterLodCadGeometry {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly triangleCount: number;
}

/** 确定性法兰盘：底板 + 中央凸台 + 12 螺栓凸台 + 12 通孔 + 12 肋板。同输入逐位同输出。 */
export function buildClusterLodCadGeometry(): ClusterLodCadGeometry {
  const vertices: number[] = [], indices: number[] = [];
  const vertex = (x: number, y: number, z: number): number => { vertices.push(x, y, z); return vertices.length / 3 - 1; };
  const quad = (a: number, b: number, c: number, d: number): void => { indices.push(a, b, c, a, c, d); };
  // 底板 96×96×8（y ∈ [-4, 4]），六面 12 三角。
  const plate = [[-48, -4, -48], [48, -4, -48], [48, -4, 48], [-48, -4, 48],
    [-48, 4, -48], [48, 4, -48], [48, 4, 48], [-48, 4, 48]] as const;
  const plateIds = plate.map(p => vertex(p[0]!, p[1]!, p[2]!));
  for (const [a, b, c, d] of [[0, 1, 2, 3], [7, 6, 5, 4], [4, 5, 1, 0], [5, 6, 2, 1], [6, 7, 3, 2], [7, 4, 0, 3]] as const) {
    quad(plateIds[a]!, plateIds[b]!, plateIds[c]!, plateIds[d]!);
  }
  // 圆柱段（y0 底环 → y1 顶环；capTop/capBottom 为盖扇；孔只留壁面）。
  const cylinder = (cx: number, cz: number, radius: number, y0: number, y1: number, segments: number,
    capTop: boolean, capBottom: boolean): void => {
    const ring0: number[] = [], ring1: number[] = [];
    for (let i = 0; i < segments; i++) {
      const angle = 2 * Math.PI * i / segments;
      const x = cx + radius * Math.cos(angle), z = cz + radius * Math.sin(angle);
      ring0.push(vertex(x, y0, z)); ring1.push(vertex(x, y1, z));
    }
    for (let i = 0; i < segments; i++) quad(ring0[i]!, ring1[i]!, ring1[(i + 1) % segments]!, ring0[(i + 1) % segments]!);
    const cap = (ring: number[], flip: boolean): void => {
      const hub = vertex(cx, flip ? y0 : y1, cz);
      for (let i = 0; i < segments; i++) {
        const j = (i + 1) % segments;
        if (flip) indices.push(hub, ring[j]!, ring[i]!); else indices.push(hub, ring[i]!, ring[j]!);
      }
    };
    if (capTop) cap(ring1, false);
    if (capBottom) cap(ring0, true);
  };
  // 中央凸台 r14 y4..38（128 段）；12 螺栓凸台 r5 y4..14（80 段）；12 通孔 r2.5 y-4..14（64 段）。
  cylinder(0, 0, 14, 4, 38, 128, true, false);
  for (let bolt = 0; bolt < 12; bolt++) {
    const angle = 2 * Math.PI * bolt / 12, cx = 36 * Math.cos(angle), cz = 36 * Math.sin(angle);
    cylinder(cx, cz, 5, 4, 14, 80, true, false);
    cylinder(cx, cz, 2.5, -4, 14, 64, false, false);
  }
  // 12 肋板：凸台到边缘的楔形薄板 y4..12（正面四边形 + 两侧三角）。
  for (let rib = 0; rib < 12; rib++) {
    const angle = 2 * Math.PI * (rib + 0.5) / 12, dx = Math.cos(angle), dz = Math.sin(angle);
    const inner = 13, outer = 46, mid = (inner + outer) / 2, half = 3;
    const base = [vertex(inner * dx, 4, inner * dz), vertex(outer * dx, 4, outer * dz),
      vertex(outer * dx, 12, outer * dz), vertex(inner * dx, 12, inner * dz)];
    const sideA = vertex(mid * dx - dz * half, 12, mid * dz + dx * half);
    const sideB = vertex(mid * dx + dz * half, 12, mid * dz - dx * half);
    quad(base[0]!, base[1]!, base[2]!, base[3]!);
    indices.push(base[1]!, base[2]!, sideA);
    indices.push(base[3]!, base[0]!, sideB);
  }
  const indexArray = Uint32Array.from(indices), vertexArray = Float32Array.from(vertices);
  const triangleCount = indexArray.length / 3;
  if (triangleCount < CLUSTER_LOD_CAD_MIN_TRIANGLES) {
    throw new Error(`Cluster LOD CAD fixture produced ${triangleCount} triangles, below the ${CLUSTER_LOD_CAD_MIN_TRIANGLES} page budget.`);
  }
  return { vertices: vertexArray, indices: indexArray, triangleCount };
}

/**
 * 列主序 viewProjection：复用 instanceVisibilityReference 的单一投影实现
 * （与 clusterLodSilhouette 的读取式 clip = VP·(world,1) 逐字一致；WebGPU 深度 [0,1]）。
 * 禁止第二套投影矩阵实现——T05 剪影验收与其共用同一口径。
 */
export function clusterLodCadViewProjection(eye: readonly [number, number, number],
  target: readonly [number, number, number], aspect = 1, near = 1, far = 200_000): Float64Array {
  return multiplyMatrix(perspectiveProjection(CLUSTER_LOD_CAD_FOV_Y, aspect, near, far),
    lookAtView(eye, target, [0, 1, 0]));
}

export interface ClusterLodCadCameraCase {
  readonly label: string;
  /** 选层相机（viewportHeightPixels = 剪影视口边长，同一像素口径）。 */
  readonly camera: ClusterLodCamera;
  /** 同机位列主序 viewProjection（剪影 CPU/GPU 双侧共用，16 floats）。 */
  readonly viewProjection: readonly number[];
}

const cameraCase = (label: string, eye: readonly [number, number, number],
  target: readonly [number, number, number]): ClusterLodCadCameraCase => {
  const distance = Math.hypot(target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]);
  const forward: readonly [number, number, number] = [(target[0] - eye[0]) / distance,
    (target[1] - eye[1]) / distance, (target[2] - eye[2]) / distance];
  return { label, camera: { position: eye, forward, viewportHeightPixels: CLUSTER_LOD_CAD_VIEWPORT,
    tanHalfFovY: Math.tan(CLUSTER_LOD_CAD_FOV_Y / 2), pixelThreshold: 1 },
    viewProjection: [...clusterLodCadViewProjection(eye, target)] };
};

/**
 * 三机位验收集（视轴深度自夹具包围尺度派生，1px 阈值边界余量 ≥30%）：
 * near ≈ 210（L0 全下钻）、mid ≈ 9.8k（L1 前沿，L2 仍 >1px）、far ≈ 19.9k（根层）。
 * 夹具 extent≈96 → bake 层误差 cell ≈ 12/24；1px 深度门槛 ≈ 7.4k/14.8k。
 */
export function buildClusterLodCadCameraCases(): readonly ClusterLodCadCameraCase[] {
  return [
    cameraCase("near-l0", [140, 90, 140], [0, 16, 0]),
    cameraCase("mid-l1", [400, 9800, 400], [0, 16, 0]),
    cameraCase("far-root", [400, 19900, 400], [0, 16, 0]),
  ];
}

/** 计划 draws（firstIndex 全局基址；baseVertex 取 indirectCommand[3] 槽位）→ 展开几何（剪影光栅化输入）。 */
export function expandFrontierGeometry(levels: readonly { readonly vertices: Float32Array;
  readonly indices: Uint32Array }[], draws: readonly { readonly triangleCount: number;
  readonly firstIndex: number; readonly indirectCommand: readonly number[] }[]): ClusterLodCadGeometry {
  const vertices = new Float32Array(levels.reduce((sum, level) => sum + level.vertices.length, 0));
  const indices = new Uint32Array(levels.reduce((sum, level) => sum + level.indices.length, 0));
  let vertexOffset = 0, indexOffset = 0;
  for (const level of levels) {
    vertices.set(level.vertices, vertexOffset);
    indices.set(level.indices, indexOffset);
    vertexOffset += level.vertices.length;
    indexOffset += level.indices.length;
  }
  const remap = new Map<number, number>(), outIndices: number[] = [], outVertices: number[] = [];
  for (const draw of draws) {
    const baseVertex = draw.indirectCommand[3]!;
    if (!Number.isSafeInteger(baseVertex) || baseVertex < 0) {
      throw new Error(`Cluster LOD CAD frontier expansion got an invalid baseVertex ${String(baseVertex)}.`);
    }
    for (let corner = 0; corner < draw.triangleCount * 3; corner++) {
      const global = indices[draw.firstIndex + corner]! + baseVertex;
      let mapped = remap.get(global);
      if (mapped === undefined) {
        mapped = outVertices.length / 3;
        remap.set(global, mapped);
        outVertices.push(vertices[global * 3]!, vertices[global * 3 + 1]!, vertices[global * 3 + 2]!);
      }
      outIndices.push(mapped);
    }
  }
  return { vertices: Float32Array.from(outVertices), indices: Uint32Array.from(outIndices),
    triangleCount: outIndices.length / 3 };
}
