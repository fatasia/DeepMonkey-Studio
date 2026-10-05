import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { installStudioCameraProbe, readStudioCameraProbe } from "./studioCameraProbe";
import type { LoadedSceneModel } from "./viewerTypes";

// 相机公平三守卫的取证缝合同:快照形状(矩阵 16 元素/对象计数/世界包围盒)与
// window 挂载生命周期(dispose 摘除、多引擎不误摘)。
describe("studioCameraProbe", () => {
  afterEach(() => {
    delete (globalThis as unknown as { __studioCameraProbe?: unknown }).__studioCameraProbe;
    vi.restoreAllMocks();
  });

  function host(overrides: Partial<Parameters<typeof readStudioCameraProbe>[0]> = {}) {
    const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 900);
    camera.position.set(3, 4, 5);
    camera.lookAt(1, 0, -2);
    camera.updateMatrixWorld(true);
    const boxObject = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    boxObject.position.set(0.5, 1, -0.25);
    boxObject.updateMatrixWorld(true);
    const models = [{
      id: "m1", name: "模型", object: boxObject, kind: "primitive" as const, visible: true, opacity: 1,
    } as LoadedSceneModel];
    return {
      scene: new THREE.Scene(),
      camera,
      orbit: { target: new THREE.Vector3(1, 0, -2) },
      renderer: { domElement: { tagName: "CANVAS" } as unknown as HTMLCanvasElement, getPixelRatio: () => 2 },
      container: { clientWidth: 1280, clientHeight: 800 } as HTMLElement,
      listModels: () => models,
      getCameraState: () => ({ position: { x: 3, y: 4, z: 5 }, target: { x: 1, y: 0, z: -2 }, mode: "orbit" as const }),
      ...overrides,
    };
  }

  it("captures camera matrices, model count and per-model world boxes read-only", () => {
    const snapshot = readStudioCameraProbe(host());
    expect(snapshot.schema).toBe("deep-monkey.studio-camera-probe.v1");
    expect(snapshot.modelCount).toBe(1);
    expect(snapshot.models[0]?.worldBox.min).toEqual([-0.5, 0, -1.25]);
    expect(snapshot.models[0]?.worldBox.max).toEqual([1.5, 2, 0.75]);
    expect(snapshot.camera.matrixWorld).toHaveLength(16);
    expect(snapshot.camera.projectionMatrix).toHaveLength(16);
    expect(snapshot.camera.position).toEqual([3, 4, 5]);
    expect(snapshot.camera.target).toEqual([1, 0, -2]);
    expect(snapshot.camera.fov).toBe(50);
    expect(snapshot.camera.aspect).toBeCloseTo(1.6, 12);
    expect(snapshot.viewport).toEqual({ clientWidth: 1280, clientHeight: 800, pixelRatio: 2 });
  });

  it("installs the window collector and uninstalls only its own mount", () => {
    const target = globalThis as unknown as { __studioCameraProbe?: () => unknown };
    const first = installStudioCameraProbe(host());
    expect(typeof target.__studioCameraProbe).toBe("function");
    expect(target.__studioCameraProbe?.()).toMatchObject({ camera: { position: [3, 4, 5] } });

    // 后来者覆盖:先挂者卸载不得误摘后来者的挂载。
    const second = installStudioCameraProbe(host());
    first();
    expect(typeof target.__studioCameraProbe).toBe("function");
    second();
    expect(target.__studioCameraProbe).toBeUndefined();
  });
});
