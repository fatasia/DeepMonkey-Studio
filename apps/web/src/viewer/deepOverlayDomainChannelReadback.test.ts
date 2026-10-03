import * as THREE from "three";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ViewerEngine } from "./ViewerEngine";
import type { MeasurementState } from "@bim-studio/contracts";

// node 测试环境无 document;标签 Canvas 的量测契约沿 sceneOverlayVisuals.test.ts 同款 stub。
beforeEach(() => {
  vi.stubGlobal("document", {
    createElement: () => {
      const context = {
        beginPath: vi.fn(), roundRect: vi.fn(), fill: vi.fn(), stroke: vi.fn(), fillText: vi.fn(),
        fillStyle: "", strokeStyle: "", lineWidth: 0, font: "", textAlign: "left", textBaseline: "middle",
        measureText: (text: string) => {
          const fontPx = Number.parseFloat(/(\d+(?:\.\d+)?)px/.exec(context.font)?.[1] ?? "10");
          return { width: [...text].length * Math.round(fontPx * 0.55) };
        },
      };
      return { width: 0, height: 0, getContext: () => context };
    },
  });
});

/**
 * J3-E 11 域升格第一批(2026-10-02)独立 CPU 测试:验证 selection /
 * measurements / annotations 三域的「引擎公开写入 API → Deep 通道 getter」
 * 耦合。沿 viewerEngineDeepOverlayRoots.test.ts 的既有模式,用
 * Object.create(ViewerEngine.prototype) + 最小字段驱动真实方法体(整条原型
 * 链,含跨分支的 ViewerEngineMeasurements 写入与 ViewerEngineInteraction 读回);
 * 唯一的桩是 TransformControls(外部库)的 attach/detach 合同与作者后效联动
 * (updatePostProcessingSelection 的 fire-and-forget,不属本批域声明)。
 * 设备侧呈现(overlay 原语→EditorOverlayPass)由 deepOverlayPrimitives/
 * deepOverlayPrimitiveSource 既有测试与 GPU probe receipt 覆盖,不在此重复。
 */

type Engine = Record<string, unknown> & { scene: THREE.Scene };

const makeEngine = (): Engine => {
  const engine = Object.create(ViewerEngine.prototype) as Engine;
  // TransformControls(外部库)合同桩:attach/detach 同步 object,helper 引用稳定
  // (updateTransformAccess 会就地对 helper.visible 赋值)。
  const helper = { visible: false };
  const transform = { enabled: false, object: undefined as THREE.Object3D | undefined, mode: "translate",
    attach: (object: THREE.Object3D) => { transform.object = object; }, detach: () => { transform.object = undefined; },
    getHelper: () => helper };
  Object.assign(engine, {
    scene: new THREE.Scene(),
    // 通道读取所需最小状态(真实方法体消费这些字段)。
    models: new Map(), layerObjects: new Map(), layerStates: new Map(), fragmentModels: new Map(), fragmentLayers: new Map(),
    annotations: new Map(), selectedId: undefined, selectedAnnotationId: undefined, selectedFragmentNodeId: undefined,
    inspectedObject: undefined, selectedSceneLight: undefined, focusedSpaceKey: undefined, selectionHelper: undefined,
    measurementPreview: undefined, readOnlyMode: false, navigationMode: "orbit", sceneAnimationPlaying: false,
    selectionScope: "model",
    presentationRendererBackend: "webgl", sceneLights: new Map(), sceneLightTargets: new Map(), transform,
    sceneLightProxies: new Map(), clippingState: { enabled: false, mode: "box", showHelper: false }, clippingHelper: undefined,
    // 作者后效联动与本批域声明无关;字段级遮蔽,其余全为真实原型方法体。
    updatePostProcessingSelection: () => undefined,
  });
  return engine;
};

describe("J3-E domain upgrade: engine write API to Deep channel getter coupling", () => {
  it("measurements: addMeasurementVisual/deleteMeasurement drive getDeepMeasurementSegmentInputs", () => {
    const engine = makeEngine(), prototype = ViewerEngine.prototype;
    const measurement: MeasurementState = { id: "m1", start: { x: -1.2, y: 0.05, z: -1.6 }, end: { x: 1.2, y: 0.05, z: -1.6 },
      distance: 2.4, kind: "distance" };
    prototype.addMeasurementVisual.call(engine as never, measurement);
    const group = engine.scene.getObjectByName("measurement:m1");
    expect(group).toBeDefined();
    expect((group!.userData as { measurement: MeasurementState }).measurement).toEqual(measurement);
    const inputs = prototype.getDeepMeasurementSegmentInputs.call(engine as never);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.a.toArray()).toEqual([-1.2, 0.05, -1.6]);
    expect(inputs[0]!.b.toArray()).toEqual([1.2, 0.05, -1.6]);
    expect(inputs[0]!.preview).toBe(false);
    expect(inputs[0]!.angle).toBeUndefined();
    prototype.deleteMeasurement.call(engine as never, "m1");
    expect(engine.scene.getObjectByName("measurement:m1")).toBeUndefined();
    expect(prototype.getDeepMeasurementSegmentInputs.call(engine as never)).toHaveLength(0);
  });

  it("annotations: addAnnotation + selectAnnotation drive listAnnotations/getDeepAnnotationInputs/getSelectedAnnotationId", () => {
    const engine = makeEngine(), prototype = ViewerEngine.prototype;
    prototype.addAnnotation.call(engine as never,
      { id: "note-1", name: "域注", position: { x: 2.2, y: 0.05, z: 0.8 }, color: "#2f8fff", visible: true, locked: false, size: 1.2 });
    expect(prototype.listAnnotations.call(engine as never)).toEqual([
      expect.objectContaining({ id: "note-1", name: "域注", visible: true, locked: false, size: 1.2 })]
    );
    expect(engine.scene.getObjectByName("annotation:note-1")).toBeDefined();
    engine.presentationRendererBackend = "webgpu";
    // webgpu 呈现后端下批注进 Deep pin 通道;selected 标志初始为 false。
    expect(prototype.getDeepAnnotationInputs.call(engine as never)).toEqual([
      expect.objectContaining({ selected: false, size: 1.2, color: "#2f8fff" })]);
    prototype.selectAnnotation.call(engine as never, "note-1");
    expect(prototype.getSelectedAnnotationId.call(engine as never)).toBe("note-1");
    const deep = prototype.getDeepAnnotationInputs.call(engine as never);
    expect(deep).toHaveLength(1);
    expect(deep[0]!.selected).toBe(true);
    expect(deep[0]!.position.toArray()).toEqual([2.2, 0.05, 0.8]);
    // webgl 呈现后端下通道显式为空(产品合同:pin 由 Deep 原生呈现,仅 Deep 模式暴露)。
    engine.presentationRendererBackend = "webgl";
    expect(prototype.getDeepAnnotationInputs.call(engine as never)).toEqual([]);
    engine.presentationRendererBackend = "webgpu";
    prototype.selectAnnotation.call(engine as never, undefined);
    expect(prototype.getDeepAnnotationInputs.call(engine as never)[0]!.selected).toBe(false);
  });

  it("selection: model selection drives scope readback and the Deep transform gizmo input", () => {
    const engine = makeEngine(), prototype = ViewerEngine.prototype;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    mesh.position.set(-2.6, 0.5, 1.4);
    engine.scene.add(mesh);
    engine.models = new Map([["marker", { id: "marker", name: "域标", object: mesh, kind: "primitive", visible: true, opacity: 1 }]]);
    expect(prototype.getSelectionScope.call(engine as never)).toBe("model");
    prototype.select.call(engine as never, "marker");
    expect(engine.selectedId).toBe("marker");
    expect(engine.inspectedObject).toBe(mesh);
    const transform = engine.transform as { object?: THREE.Object3D; getHelper: () => { visible: boolean } };
    expect(transform.object).toBe(mesh);
    expect(transform.getHelper().visible).toBe(true);
    const gizmo = prototype.getDeepTransformGizmoInput.call(engine as never);
    expect(gizmo).toMatchObject({ mode: "translate" });
    expect(gizmo!.matrix.equals(mesh.matrixWorld)).toBe(true);
    // 产品语义:纯 model 选择 inspectedObject === selected.object,不建 selectionHelper。
    expect(engine.selectionHelper).toBeUndefined();
    expect(prototype.getDeepSelectionBox.call(engine as never)).toBeUndefined();
    prototype.select.call(engine as never, undefined);
    expect(engine.selectedId).toBeUndefined();
    expect(transform.object).toBeUndefined();
    expect(transform.getHelper().visible).toBe(false);
    expect(prototype.getDeepTransformGizmoInput.call(engine as never)).toBeUndefined();
  });

  it("selection box: inspecting a non-root layer object yields the helper box the Deep box primitive consumes", () => {
    const engine = makeEngine(), prototype = ViewerEngine.prototype;
    // 产品形态:inspectedObject 是 model.object 子树内的 layer 节点(两者必须不同)。
    const root = new THREE.Group();
    const child = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2, 0.5));
    child.position.set(3, 1, -2);
    root.add(child);
    engine.scene.add(root);
    const model = { id: "model-a", name: "A", object: root, kind: "model" as const, visible: true, opacity: 1 };
    engine.models = new Map([["model-a", model]]);
    engine.layerObjects = new Map([["model-a", new Map([["shell", child]])]]);
    // 产品路径:layer 检查使 inspectedObject !== selected.object → 建 selectionHelper。
    engine.selectedId = "model-a";
    engine.inspectedObject = child;
    (prototype as unknown as { updateSelectionHelper: () => void }).updateSelectionHelper.call(engine as never);
    const helper = engine.selectionHelper as { box: THREE.Box3; name: string };
    expect(helper).toBeDefined();
    expect(helper.name).toBe("helper:selection");
    const box = prototype.getDeepSelectionBox.call(engine as never);
    expect(box).toBeDefined();
    expect(box!.isEmpty()).toBe(false);
    const reference = new THREE.Box3().setFromObject(child);
    expect(box!.min.toArray()).toEqual(reference.min.toArray());
    expect(box!.max.toArray()).toEqual(reference.max.toArray());
  });
});

/**
 * J3-E 11 域升格第二批(2026-10-02)独立 CPU 测试:camera-views-default-views
 * default-view 腿(setStandardView→引擎相机态)与 selection layer 腿
 * (selectLayer 非 fragment 路径→selectionBox/getSelectedLayerId/getLayerTree)。
 * 沿批一同款模式驱动真实方法体;域外耦合并(导航设置/裁剪/碰撞锚点/请求渲染)
 * 沿批一"字段级遮蔽"先例,相机位姿写回(focusBox/sceneContentBox)保持真实。
 */
describe("J3-E domain upgrade batch 2: default-view and layer legs", () => {
  const shadowOutOfScope = (engine: Engine): void => {
    Object.assign(engine, {
      configureNavigationControls: () => undefined,
      applyCameraClippingRange: () => undefined,
      resetCameraCollisionAnchor: () => undefined,
      requestRender: () => undefined,
    });
  };

  it("camera-views-default-views: setStandardView writes the engine camera state the recovered view consumes", () => {
    const engine = makeEngine(), prototype = ViewerEngine.prototype;
    const camera = new THREE.PerspectiveCamera(55, 840 / 650, 0.1, 2000);
    camera.position.set(6, 5, 7);
    const boxMesh = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), new THREE.MeshStandardMaterial());
    boxMesh.position.set(0.25, 1.5, -0.125);
    engine.scene.add(boxMesh);
    Object.assign(engine, {
      camera,
      orbit: { target: new THREE.Vector3(0, 0.5, 0), update: () => undefined },
      cameraConstraints: { minDistance: 0.5, maxDistance: 80, minPolarAngle: 5, maxPolarAngle: 175,
        nearClip: 0.05, farClip: 4000, collisionRadius: 0.6, collisionEnabled: false },
      viewportOrbitIntent: true,
      navigationMode: "orbit",
      cameraChangeListeners: new Set(),
      navigationViewStates: new Map(),
      models: new Map([["box", { id: "box", name: "B", object: boxMesh, kind: "primitive", visible: true, opacity: 1 }]]),
    });
    shadowOutOfScope(engine);
    const before = camera.position.clone();
    prototype.setStandardView.call(engine as never, "front");
    // 正向视图应用改写相机位姿(非入口视图),目标=场景内容盒中心,up 保持 (0,1,0)。
    expect(camera.position.distanceTo(before)).toBeGreaterThan(1e-6);
    expect((engine.orbit as { target: THREE.Vector3 }).target.toArray()).toEqual(boxMesh.position.toArray());
    expect(camera.up.toArray()).toEqual([0, 1, 0]);
    expect(engine.navigationMode).toBe("orbit");
    // 幂等确定性:同一视图重复应用,位姿逐字段不变(GPU receipt 两侧同态的前提)。
    const applied = camera.position.clone();
    prototype.setStandardView.call(engine as never, "front");
    expect(camera.position.equals(applied)).toBe(true);
    expect((engine.orbit as { target: THREE.Vector3 }).target.toArray()).toEqual(boxMesh.position.toArray());
  });

  it("selection layer leg: selectLayer (non-fragment registry path) drives getSelectedLayerId/getDeepSelectionBox/gizmo/getLayerTree", () => {
    const engine = makeEngine(), prototype = ViewerEngine.prototype;
    // 产品装配形态:glTF 场景(注册为 model)→ 可见 Group(层节点)→ 不可见 Mesh。
    // updateSelectionHelper 只要求 inspectedObject 自身 visible(viewerEngineRendering.ts:73);
    // Box3 经子级几何照常成盒(expandByObject 不查子级 visible)。
    const root = new THREE.Group(); root.name = "model-root"; root.userData.layerNodeId = "root";
    const layerGroup = new THREE.Group(); layerGroup.name = "layer-group"; layerGroup.userData.layerNodeId = "root/0";
    const layerMesh = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.9, 1.2));
    layerMesh.name = "layer-mesh"; layerMesh.visible = false;
    layerGroup.add(layerMesh); root.add(layerGroup); engine.scene.add(root);
    engine.models = new Map([["model-l", { id: "model-l", name: "L", object: root, kind: "model" as const, visible: true, opacity: 1 }]]);
    engine.layerObjects = new Map([["model-l", new Map([["root", root], ["root/0", layerGroup]])]]);
    (engine as unknown as { fragmentTrees: Map<string, unknown> }).fragmentTrees = new Map();
    prototype.selectLayer.call(engine as never, "model-l", "root/0");
    expect(engine.selectedId).toBe("model-l");
    expect(engine.inspectedObject).toBe(layerGroup);
    expect(prototype.getSelectedLayerId.call(engine as never)).toBe("root/0");
    const box = prototype.getDeepSelectionBox.call(engine as never);
    expect(box).toBeDefined();
    const reference = new THREE.Box3().setFromObject(layerGroup);
    expect(box!.min.toArray()).toEqual(reference.min.toArray());
    expect(box!.max.toArray()).toEqual(reference.max.toArray());
    // 层选在 orbit 模式下挂 transform gizmo(真实 updateTransformAccess 路径)。
    const transform = engine.transform as { object?: THREE.Object3D };
    expect(transform.object).toBe(layerGroup);
    expect(prototype.getDeepTransformGizmoInput.call(engine as never)).toMatchObject({ mode: "translate" });
    // 层树读回(域结构载体)。
    const tree = prototype.getLayerTree.call(engine as never, "model-l");
    expect(tree?.id).toBe("root");
    expect(tree?.children?.[0]?.name).toBe("layer-group");
    expect(tree?.children?.[0]?.children?.[0]?.name).toBe("layer-mesh");
  });
});

// 防回归哨兵:collectDeepOverlayPrimitives 消费的访问器面与本测试覆盖的 getter
// 必须保持同一合同(升格 receipt 引擎通道的静态锚点)。
describe("J3-E domain upgrade: DeepOverlayPrimitiveViewer contract stays aligned", () => {
  it("ViewerEngine exposes every accessor the Deep overlay collector consumes", async () => {
    const { collectDeepOverlayPrimitives } = await import("./deepOverlayPrimitiveSource");
    const engine = makeEngine();
    engine.presentationRendererBackend = "webgpu";
    // 空场景下收集器不抛错且返回空原语集(选择盒/测量/批注全缺省)。
    const primitives = collectDeepOverlayPrimitives(engine as never, 64, 48, 1);
    expect(primitives).toEqual([]);
    expect(typeof ViewerEngine.prototype.getDeepSelectionBox).toBe("function");
    expect(typeof ViewerEngine.prototype.getDeepMeasurementSegmentInputs).toBe("function");
    expect(typeof ViewerEngine.prototype.getDeepAnnotationInputs).toBe("function");
    expect(typeof ViewerEngine.prototype.getDeepTransformGizmoInput).toBe("function");
    // 第二批通道锚点:default-view 腿与 layer 腿的读回面。
    expect(typeof ViewerEngine.prototype.setStandardView).toBe("function");
    expect(typeof ViewerEngine.prototype.getSelectedLayerId).toBe("function");
    expect(typeof ViewerEngine.prototype.getLayerTree).toBe("function");
    expect(typeof ViewerEngine.prototype.selectLayer).toBe("function");
  });

  // 同族回归哨兵(2026-10-02 缺陷修复):测量/批注材质必须满足深 overlay 投影
  // 合同(studioDeepEditorOverlay 拒绝 toneMapped 材质;灯光代理/选择盒同场景
  // 既有约定均为 toneMapped=false)。缺失会使 Deep 切换与恢复在候选准备窗口
  // 以 "Unsupported editor overlay material." 失败。
  it("measurement and annotation visuals satisfy the Deep overlay material contract", async () => {
    const { createMeasurementVisual, createAnnotationVisual } = await import("./sceneOverlayVisuals");
    const assertContract = (visual: THREE.Object3D) => {
      visual.traverse(object => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh && !(object as THREE.Line).isLine) return;
        const material = mesh.material as THREE.MeshBasicMaterial | THREE.LineBasicMaterial;
        expect(material.depthTest).toBe(false);
        expect(material.toneMapped).toBe(false);
      });
    };
    assertContract(createMeasurementVisual(
      { id: "m1", start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 }, distance: 1, kind: "distance" }, false));
    assertContract(createAnnotationVisual(
      { id: "a1", name: "注", position: { x: 0, y: 0, z: 0 }, color: "#2f8fff", visible: true, locked: false }, true));
    // angle 腿的弧线用 line 材质 clone,必须继承合同。
    assertContract(createMeasurementVisual(
      { id: "m2", start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 }, distance: 1, kind: "angle",
        points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }], angle: Math.PI / 2 }, false));
  });
});
