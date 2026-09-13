import * as THREE from "three";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { annotationLabelCanvasWidth, createAnnotationVisual, createMeasurementVisual, disposeViewerObject, updateAnnotationVisualPresentation } from "./sceneOverlayVisuals";
import { PrimitiveGeometryCache } from "./primitiveGeometry";

beforeEach(() => {
  vi.stubGlobal("document", {
    createElement: () => {
      // 量测契约：宽度随 context.font 字号变化（每字符 = 字号 × 0.55），
      // 这样"未设置字体就量测"的实现错误会在单测中暴露。
      const context = {
        beginPath: vi.fn(),
        roundRect: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        fillText: vi.fn(),
        fillStyle: "",
        strokeStyle: "",
        lineWidth: 0,
        font: "",
        textAlign: "left",
        textBaseline: "middle",
        measureText: (text: string) => {
          const fontPx = Number.parseFloat(/(\d+(?:\.\d+)?)px/.exec(context.font)?.[1] ?? "10");
          return { width: [...text].length * Math.round(fontPx * 0.55) };
        },
      };
      return { width: 0, height: 0, getContext: () => context };
    },
  });
});

describe("scene overlay visuals", () => {
  it("构造包含线、端点和标签的测量覆盖层", () => {
    const visual = createMeasurementVisual({
      id: "measure-1",
      kind: "distance",
      start: { x: 0, y: 0, z: 0 },
      end: { x: 2, y: 0, z: 0 },
      distance: 2
    }, false);

    expect(visual.children).toHaveLength(4);
    expect(visual.children[0]).toBeInstanceOf(THREE.Line);
    expect(visual.children[1]).toBeInstanceOf(THREE.Mesh);
    expect(visual.children[3]).toBeInstanceOf(THREE.Sprite);
  });

  it("保持批注身份、显隐和选中颜色的视觉契约", () => {
    const visual = createAnnotationVisual({
      id: "annotation-1",
      name: "泵站检修点",
      description: "需要复核",
      position: { x: 1, y: 2, z: 3 },
      color: "#ff5500",
      visible: false,
      locked: false,
      size: 1
    }, true);

    expect(visual.name).toBe("annotation:annotation-1");
    expect(visual.visible).toBe(false);
    expect(visual.position.toArray()).toEqual([1, 2, 3]);
    expect(visual.children).toHaveLength(3);
    expect(visual.children.every((child) => child.userData.annotationId === "annotation-1")).toBe(true);
    const labelMaterial = (visual.children[2] as THREE.Sprite).material as THREE.SpriteMaterial;
    expect(labelMaterial.depthWrite).toBe(false);
    expect(labelMaterial.alphaTest).toBeGreaterThan(0);
  });

  it("只在只读浏览标签上公开会话级关闭入口", () => {
    const state = {
      id: "annotation-dismiss",
      name: "可关闭标签",
      position: { x: 0, y: 0, z: 0 },
      color: "#2f8fff",
      visible: true,
      locked: false,
    };
    const editorSprite = createAnnotationVisual(state, false).children[2] as THREE.Sprite;
    const viewerSprite = createAnnotationVisual(state, false, true).children[2] as THREE.Sprite;

    expect(editorSprite.userData.dismissible).toBe(false);
    expect(viewerSprite.userData.dismissible).toBe(true);
  });

  it("标签底板宽度随文本实测收缩，短文本不再大片留白", () => {
    const base = {
      id: "annotation-size",
      name: "泵",
      position: { x: 0, y: 0, z: 0 },
      color: "#2f8fff",
      visible: true,
      locked: false,
      size: 1,
    };
    const compact = createAnnotationVisual(base, false).children[2] as THREE.Sprite;
    const described = createAnnotationVisual({ ...base, description: "需要复核运行参数的一段较长描述" }, false).children[2] as THREE.Sprite;
    const longTitle = createAnnotationVisual({ ...base, name: "泵".repeat(16) }, false).children[2] as THREE.Sprite;
    const ratioOf = (sprite: THREE.Sprite) => Number(sprite.userData.baseWidth) / Number(sprite.userData.baseHeight);

    // stub 量测（标题 52px→29/字、描述 34px→19/字）：短名无描述 → 收缩到最小画布 224/160；
    // 描述 15 字 × 19px → 画布 368；更长的纯标题画布更宽，且不超过 1024 上限。
    expect(ratioOf(compact)).toBeCloseTo(224 / 160, 5);
    expect(ratioOf(described)).toBeCloseTo(368 / 160, 5);
    expect(ratioOf(longTitle)).toBeGreaterThan(ratioOf(described));
    expect(Number(longTitle.userData.baseWidth)).toBeLessThanOrEqual(0.6 * 6.4);
  });

  it("annotationLabelCanvasWidth 服从最小与最大画布约束", () => {
    expect(annotationLabelCanvasWidth(0, 0, false)).toBe(224);
    expect(annotationLabelCanvasWidth(0, 0, true)).toBe(224);
    expect(annotationLabelCanvasWidth(5_000, 0, false)).toBe(1024);
    expect(annotationLabelCanvasWidth(0, 5_000, true)).toBe(1024);
    expect(annotationLabelCanvasWidth(320, 0, false)).toBe(416);
  });

  it("碰撞候选框等于 Sprite 当前的真实投影矩形", () => {
    const visual = createAnnotationVisual({
      id: "annotation-projected",
      name: "循环泵",
      description: "运行正常",
      position: { x: 0, y: 0, z: 0 },
      color: "#22c55e",
      visible: true,
      locked: false,
      size: 1,
    }, false);
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 1_000);
    camera.position.set(6, 4, 50);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const result = updateAnnotationVisualPresentation("annotation-projected", visual, camera, 1_600, 900, false);
    expect(result).toBeDefined();
    const { sprite, candidate } = result!;
    const world = sprite.getWorldPosition(new THREE.Vector3());
    const viewDepth = -world.clone().applyMatrix4(camera.matrixWorldInverse).z;
    const worldHeightPerPixel = 2 * Math.max(viewDepth, 0.01) * Math.tan(camera.fov * Math.PI / 360) / 900;
    const projected = world.clone().project(camera);

    expect(candidate.height).toBeCloseTo(sprite.scale.y / worldHeightPerPixel, 3);
    expect(candidate.width).toBeCloseTo(sprite.scale.x / worldHeightPerPixel, 3);
    expect(candidate.width / candidate.height).toBeCloseTo(sprite.scale.x / sprite.scale.y, 3);
    expect(candidate.centerX).toBeCloseTo((projected.x + 1) * 800, 3);
    expect(candidate.centerY).toBeCloseTo((1 - projected.y) * 450, 3);
  });

  it("相机正后方的标签不产出碰撞候选且被隐藏", () => {
    const visual = createAnnotationVisual({
      id: "annotation-behind",
      name: "背后标签",
      position: { x: 0, y: 0, z: 0 },
      color: "#22c55e",
      visible: true,
      locked: false,
      size: 1,
    }, false);
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 1_000);
    camera.position.set(0, 0, -10);
    camera.updateMatrixWorld(true);
    const sprite = visual.children[2] as THREE.Sprite;
    const result = updateAnnotationVisualPresentation("annotation-behind", visual, camera, 1_600, 900, false);
    expect(result).toBeUndefined();
    expect(sprite.visible).toBe(false);
  });

  it("根据相机距离调整标签而不重建纹理，并保持选中标签可见", () => {    const visual = createAnnotationVisual({
      id: "annotation-far",
      name: "远端泵站",
      description: "运行正常",
      position: { x: 0, y: 0, z: 0 },
      color: "#22c55e",
      visible: true,
      locked: false,
      size: 1,
    }, false);
    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 1_000);
    camera.position.set(0, 0, 50);
    const sprite = visual.children[2] as THREE.Sprite;
    const texture = (sprite.material as THREE.SpriteMaterial).map;

    updateAnnotationVisualPresentation("annotation-far", visual, camera, 1_600, 900, false);
    expect(sprite.scale.y).toBeGreaterThan(0.6);
    expect(sprite.position.y).toBeGreaterThan(0.8);
    expect((sprite.material as THREE.SpriteMaterial).map).toBe(texture);

    camera.position.z = 180;
    updateAnnotationVisualPresentation("annotation-far", visual, camera, 1_600, 900, true);
    expect(sprite.visible).toBe(true);
    expect((sprite.material as THREE.SpriteMaterial).opacity).toBe(1);
  });

  it("从父节点移除并释放几何与材质", () => {
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshBasicMaterial();
    const disposeGeometry = vi.spyOn(geometry, "dispose");
    const disposeMaterial = vi.spyOn(material, "dispose");
    const mesh = new THREE.Mesh(geometry, material);
    const parent = new THREE.Group();
    parent.add(mesh);

    disposeViewerObject(mesh);

    expect(mesh.parent).toBeNull();
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
  });

  it("移除单个设备时保留查看器共享的基础几何", () => {
    const cache = new PrimitiveGeometryCache();
    const geometry = cache.get("box");
    const disposeGeometry = vi.spyOn(geometry, "dispose");
    disposeViewerObject(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
    expect(disposeGeometry).not.toHaveBeenCalled();

    cache.dispose();
    expect(disposeGeometry).toHaveBeenCalledOnce();
  });

  it("释放标签实例时保留 Three 内部共享的 Sprite 几何", () => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial());
    const disposeGeometry = vi.spyOn(sprite.geometry, "dispose");
    const disposeMaterial = vi.spyOn(sprite.material, "dispose");

    disposeViewerObject(sprite);

    expect(disposeGeometry).not.toHaveBeenCalled();
    expect(disposeMaterial).toHaveBeenCalledOnce();
  });

  it("释放批注时归还标签纹理引用并保留缓存", () => {
    const visual = createAnnotationVisual({
      id: "annotation-dispose",
      name: "待释放标签",
      position: { x: 0, y: 0, z: 0 },
      color: "#2f8fff",
      visible: true,
      locked: false,
      size: 1,
    }, false);
    const sprite = visual.children[2] as THREE.Sprite;
    const texture = (sprite.material as THREE.SpriteMaterial).map!;
    const disposeTexture = vi.spyOn(texture, "dispose");

    disposeViewerObject(visual);

    // 标签纹理进入有上限的复用池；超出上限且无引用时才真正释放。
    expect(disposeTexture).not.toHaveBeenCalled();
  });
});
