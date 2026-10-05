import * as THREE from "three";
import type { CameraState } from "@bim-studio/contracts";
import { visibleObjectBox } from "./sceneObjectUtils";
import type { LoadedSceneModel } from "./viewerTypes";

/**
 * 跨后端公平对比的只读取证缝(模式同 startupEvidence 的 window 采集入口)。
 *
 * 门禁脚本(公平对比等)需要在"适应整个场景"复位与魔方位姿点击后,对拍三后端
 * 实际生效的相机状态与场景对象计数——此前门只断言 guards(黑帧/亮度/自身确定性),
 * 位姿/对象数/相机矩阵无守卫,相机命令在 Deep 桥丢失时门仍 passed。
 *
 * 纯读、无副作用;引擎 dispose 时摘除,不悬挂引用。同一页面多引擎时后挂者覆盖
 * 前挂者(单视口产品形态),dispose 只摘除属于自己的挂载。
 */

export interface StudioCameraProbeSnapshot {
  readonly schema: "deep-monkey.studio-camera-probe.v1";
  readonly capturedAtMs: number;
  /** 作者层场景对象计数(模型根,不含辅助对象);跨后端一致性守卫的输入。 */
  readonly modelCount: number;
  readonly models: readonly { readonly id: string; readonly kind: string; readonly visible: boolean;
    /** 世界包围盒(与 fitAll 的 sceneContentBox 同源),跨后端漂移归因用。 */
    readonly worldBox: { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] } }[];
  readonly navigationMode: string;
  readonly camera: {
    readonly position: readonly [number, number, number];
    /** orbit 目标点(相机合同单一事实源的另一半)。 */
    readonly target: readonly [number, number, number];
    readonly up: readonly [number, number, number];
    readonly fov: number;
    readonly zoom: number;
    readonly aspect: number;
    readonly near: number;
    readonly far: number;
    readonly matrixWorld: readonly number[];
    readonly projectionMatrix: readonly number[];
  };
  readonly viewport: { readonly clientWidth: number; readonly clientHeight: number; readonly pixelRatio: number };
}

interface StudioCameraProbeHost {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly orbit: { readonly target: THREE.Vector3 };
  readonly renderer: { readonly domElement: HTMLCanvasElement; getPixelRatio(): number };
  readonly container: HTMLElement;
  listModels(): readonly LoadedSceneModel[];
  getCameraState(): CameraState;
}

function boxField(box: THREE.Box3): { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] } {
  return box.isEmpty()
    ? { min: [0, 0, 0], max: [0, 0, 0] }
    : { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
}

type ProbeWindow = { __studioCameraProbe?: () => StudioCameraProbeSnapshot };

function vector3(value: THREE.Vector3): readonly [number, number, number] {
  return [value.x, value.y, value.z];
}

export function readStudioCameraProbe(host: StudioCameraProbeHost): StudioCameraProbeSnapshot {
  const camera = host.camera;
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const models = host.listModels();
  const domElement = host.renderer.domElement;
  return {
    schema: "deep-monkey.studio-camera-probe.v1",
    capturedAtMs: Math.round(performance.timeOrigin + performance.now()),
    modelCount: models.length,
    models: models.map(model => ({ id: model.id, kind: model.kind, visible: model.visible,
      worldBox: boxField(visibleObjectBox(model.object)) })),
    navigationMode: host.getCameraState().mode,
    camera: {
      position: vector3(camera.position),
      target: vector3(host.orbit.target),
      up: vector3(camera.up),
      fov: camera.fov,
      zoom: camera.zoom,
      aspect: camera.aspect,
      near: camera.near,
      far: camera.far,
      matrixWorld: Array.from(camera.matrixWorld.elements, value => Number(value.toFixed(9))),
      projectionMatrix: Array.from(camera.projectionMatrix.elements, value => Number(value.toFixed(9))),
    },
    viewport: {
      clientWidth: host.container.clientWidth,
      clientHeight: host.container.clientHeight,
      pixelRatio: host.renderer.getPixelRatio(),
    },
  };
}

/** 挂载 window.__studioCameraProbe;返回卸载函数(dispose 时调用)。 */
export function installStudioCameraProbe(host: StudioCameraProbeHost): () => void {
  const target = globalThis as unknown as ProbeWindow;
  const probe = (() => readStudioCameraProbe(host)) as (() => StudioCameraProbeSnapshot) & { host?: unknown };
  probe.host = host;
  target.__studioCameraProbe = probe;
  return () => {
    // 只摘自己的挂载:快照函数闭包持有本 host,标记比对防误摘后来者。
    if ((target.__studioCameraProbe as unknown as { host?: unknown } | undefined)?.host === host) {
      delete target.__studioCameraProbe;
    }
  };
}
