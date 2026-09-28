/**
 * T05 真机探针夹具：墙洞场景（instanceVisibilityFixture 的 136 实例版）→ 打包请求 +
 * Node 侧参考集与参考深度 mip 链。与浏览器探针（instanceCullingGpuProbe.ts）共用本文件，
 * 保证场景/参考单一来源。仅供参考与脚本导入；不是测试文件。
 */

import { buildInstanceVisibilityReference, lookAtView, multiplyMatrix, perspectiveProjection,
  type ReferenceGeometry, type ReferenceInstance } from "../src/webgpu/instanceVisibilityReference.js";
import { buildDepthPyramid } from "../src/webgpu/instanceVisibilityTwin.js";
import { packBounds, packCullingInstances, packFrustum, type CullingInstance } from "../src/webgpu/gpuFrustumPacking.js";
import { quadGeometry, scene, VIEWPORT, NEAR, FAR, FOV } from "../src/webgpu/instanceVisibilityFixture.js";
import type { TwinView } from "../src/webgpu/instanceVisibilityTwin.js";

export interface CullingGpuScene {
  readonly instances: readonly ReferenceInstance[];
  readonly geometry: ReferenceGeometry;
  readonly viewProjection: Float32Array;
  readonly cameraPosition: readonly [number, number, number];
  readonly reversedZ: boolean;
  readonly twinView: TwinView;
  readonly cullingInstances: readonly CullingInstance[];
  readonly instancesBase64: string;
  readonly boundsBase64: string;
  readonly frustumBase64: string;
  readonly viewProjectionBase64: string;
  readonly indexCount: number;
  /** 参考深度 mip 链（视图深度约定；reversedZ 时为大=近）。 */
  readonly depthMips: readonly { readonly width: number; readonly height: number; readonly dataBase64: string }[];
  readonly referenceVisible: Uint8Array;
  readonly referenceVisibleCount: number;
}

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

export function buildCullingGpuScene(eye: readonly [number, number, number] = [0, 0, 30],
  reversedZ = false): CullingGpuScene {
  const aspect = VIEWPORT[0]! / VIEWPORT[1]!;
  const f = 1 / Math.tan(FOV / 2);
  const projection = reversedZ
    ? new Float64Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, NEAR / (FAR - NEAR), -1, 0, 0, NEAR * FAR / (FAR - NEAR), 0])
    : perspectiveProjection(FOV, aspect, NEAR, FAR);
  const viewProjection = Float32Array.from(multiplyMatrix(projection, lookAtView(eye, [0, 0, 0], [0, 1, 0])));
  const { instances } = scene();
  const geometry = quadGeometry();
  const reference = buildInstanceVisibilityReference(geometry, instances,
    { viewProjection, viewport: VIEWPORT, reversedZ });
  const cullingInstances: CullingInstance[] = instances.map(instance => ({
    modelMatrix: Array.from(instance.transform), bounds: [0, 0, 0, Math.SQRT2] }));
  const pyramid = buildDepthPyramid(reversedZ
    ? Float32Array.from(reference.depth, depth => 1 - depth) : reference.depth.slice(),
    VIEWPORT[0]!, VIEWPORT[1]!, reversedZ);
  // 视锥平面：与生产 viewProjectionFrustum 同式（行组合），四分量 f32 打包。
  const row = (index: number): readonly number[] =>
    [viewProjection[index]!, viewProjection[4 + index]!, viewProjection[8 + index]!, viewProjection[12 + index]!];
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
  const add = (a: readonly number[], b: readonly number[]) => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!, a[3]! + b[3]!];
  const sub = (a: readonly number[], b: readonly number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!, a[3]! - b[3]!];
  const planes = [add(r3, r0), sub(r3, r0), add(r3, r1), sub(r3, r1), r2, sub(r3, r2)];
  const frustumBytes = new Float32Array(planes.flat());
  return {
    instances, geometry, viewProjection,
    cameraPosition: [eye[0], eye[1], eye[2]], reversedZ,
    twinView: { viewProjection, cameraPosition: [eye[0], eye[1], eye[2]], viewport: VIEWPORT, reversedZ },
    cullingInstances,
    instancesBase64: toBase64(new Uint8Array(packCullingInstances(cullingInstances))),
    boundsBase64: toBase64(new Uint8Array(packBounds(cullingInstances))),
    frustumBase64: toBase64(new Uint8Array(frustumBytes.buffer)),
    viewProjectionBase64: toBase64(new Uint8Array(viewProjection.buffer, viewProjection.byteOffset, viewProjection.byteLength)),
    indexCount: geometry.indices.length,
    depthMips: pyramid.levels.map(level => ({ width: level.width, height: level.height,
      dataBase64: toBase64(new Uint8Array(level.data.buffer, level.data.byteOffset, level.data.byteLength)) })),
    referenceVisible: reference.visible,
    referenceVisibleCount: reference.visible.reduce((sum, value) => sum + value, 0),
  };
}
