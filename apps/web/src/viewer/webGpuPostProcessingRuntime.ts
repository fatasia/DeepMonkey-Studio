import type * as THREE from "three";
import { RenderPipeline, type Node, type WebGPURenderer } from "three/webgpu";
import { hue as adjustHue, mrt, normalView, output, pass, renderOutput, saturation as adjustSaturation, uniform, vec3, vec4 } from "three/tsl";
import { afterImage } from "three/examples/jsm/tsl/display/AfterImageNode.js";
import { bloom } from "three/examples/jsm/tsl/display/BloomNode.js";
import { vignette } from "three/examples/jsm/tsl/display/CRT.js";
import { dof } from "three/examples/jsm/tsl/display/DepthOfFieldNode.js";
import { film } from "three/examples/jsm/tsl/display/FilmNode.js";
import { fxaa } from "three/examples/jsm/tsl/display/FXAANode.js";
import { ao } from "three/examples/jsm/tsl/display/GTAONode.js";
import { outline } from "three/examples/jsm/tsl/display/OutlineNode.js";
import { smaa } from "three/examples/jsm/tsl/display/SMAANode.js";
import type { ScenePostProcessingState } from "@bim-studio/contracts";
import type { ViewerPostProcessingRuntime } from "./viewerPostProcessingRuntime";
import { createWebGpuPostProcessingPlan } from "./webGpuPostProcessingPlan";

type NumericUniform = { value: number };
type DisposableNode = { dispose?: () => void; setSize?: (width: number, height: number) => void };

interface RuntimeControls {
  ao?: {
    radius: NumericUniform;
    scale: NumericUniform;
    thickness: NumericUniform;
  };
  bloom?: {
    strength: NumericUniform;
    threshold: NumericUniform;
  };
  outline?: { selectedObjects: THREE.Object3D[] };
  outlineStrength?: NumericUniform;
  vignette?: NumericUniform;
  film?: NumericUniform;
  afterimage?: NumericUniform;
  focusDistance?: NumericUniform;
  bokehScale?: NumericUniform;
  hue?: NumericUniform;
  saturation?: NumericUniform;
  brightness?: NumericUniform;
  contrast?: NumericUniform;
}

/**
 * WebGPU 的 TSL 后处理管线。
 * 开关变化时才重建节点图；强度、焦距等连续参数通过 uniform 更新，避免拖动控件时反复编译。
 */
export class WebGpuPostProcessingRuntime implements ViewerPostProcessingRuntime {
  readonly #pipeline: RenderPipeline;
  #resources: DisposableNode[] = [];
  #retiredResources: DisposableNode[][] = [];
  #controls: RuntimeControls = {};
  #variant = "";
  #width = 1;
  #height = 1;

  constructor(
    renderer: WebGPURenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    this.#pipeline = new RenderPipeline(renderer);
  }

  apply(state: ScenePostProcessingState, outlinedObjects: THREE.Object3D[]): void {
    const plan = createWebGpuPostProcessingPlan(state, outlinedObjects.length);
    // 场景切换会短暂没有轮廓目标，但节点图仍可安全复用；避免在“无目标/有目标”之间
    // 来回重建 OutlineNode，产生新的 RenderTarget 与 WebGPU 纹理。
    if (plan.variant === "scene" && this.#variant.includes("outline")) {
      this.updateParameters(state, outlinedObjects);
      return;
    }
    if (plan.variant !== this.#variant) {
      this.rebuild(state, outlinedObjects, plan);
      this.#variant = plan.variant;
    }
    this.updateParameters(state, outlinedObjects);
  }

  suspend(): void {
    if (this.#controls.outline) this.#controls.outline.selectedObjects = [];
    // 场景切换只改变 OutlineNode 的目标对象，不改变节点图结构。
    // 保留变体可避免每次切换都重建 RenderTarget/NodeBuilder，降低 WebGPU 纹理增长与编译抖动。
  }

  setPixelRatio(_value: number): void {
    // TSL Pass 直接跟随 WebGPURenderer 的实际绘制缓冲，无需维护第二份像素比。
  }

  setSize(width: number, height: number): void {
    this.#width = Math.max(1, width);
    this.#height = Math.max(1, height);
    this.#resources.forEach((resource) => resizeResource(resource, this.#width, this.#height));
  }

  render(_delta: number): void {
    this.#pipeline.render();
    // BloomNode 的内部模糊材质在首次编译时才创建；必须等本帧管线执行后再统一调整尺寸。
    // 在 rebuild() 阶段提前 setSize 会触发 Three r185 的空材质访问，进而中断整帧渲染。
    this.#resources.forEach((resource) => resizeResource(resource, this.#width, this.#height));
    // 新图已成功提交后再释放旧 RenderTarget，避免材质切换与 GPU 提交产生生命周期竞态。
    this.#retiredResources.splice(0).flat().forEach(disposeNode);
  }

  dispose(): void {
    this.#pipeline.dispose();
    [...this.#resources, ...this.#retiredResources.flat()].forEach(disposeNode);
    this.#resources = [];
    this.#retiredResources = [];
    this.#controls = {};
  }

  private rebuild(
    state: ScenePostProcessingState,
    outlinedObjects: THREE.Object3D[],
    plan: ReturnType<typeof createWebGpuPostProcessingPlan>,
  ): void {
    const previousResources = this.#resources;
    const resources: DisposableNode[] = [];
    const controls: RuntimeControls = {};
    const scenePass = pass(this.scene, this.camera);
    resources.push(scenePass);

    if (plan.ao) scenePass.setMRT(mrt({ output, normal: normalView }));
    let result: Node<"vec4"> = scenePass.getTextureNode("output");

    if (plan.ao) {
      const aoNode = ao(scenePass.getTextureNode("depth"), scenePass.getTextureNode("normal"), this.camera);
      aoNode.resolutionScale = 0.5;
      aoNode.useTemporalFiltering = true;
      resources.push(aoNode);
      controls.ao = aoNode;
      result = result.mul(vec4(vec3(aoNode.getTextureNode().r), 1));
    }

    if (plan.outline) {
      const edgeStrength = uniform(state.outlineStrength ?? 2.5);
      const outlineNode = outline(this.scene, this.camera, {
        selectedObjects: outlinedObjects,
        edgeThickness: uniform(1),
        edgeGlow: uniform(0),
        downSampleRatio: 2,
      });
      resources.push(outlineNode);
      controls.outline = outlineNode;
      controls.outlineStrength = edgeStrength;
      const visibleEdge = outlineNode.visibleEdge.mul(vec3(0.3, 0.62, 1));
      const hiddenEdge = outlineNode.hiddenEdge.mul(vec3(0.14, 0.29, 0.44));
      result = result.add(vec4(visibleEdge.add(hiddenEdge).mul(edgeStrength), 0));
    }

    if (plan.bloom) {
      const bloomNode = bloom(result, state.bloomStrength, 0.25, state.bloomThreshold);
      resources.push(bloomNode);
      controls.bloom = bloomNode;
      result = result.add(bloomNode);
    }

    if (plan.depthOfField) {
      const focusDistance = uniform(state.focusDistance ?? 10);
      const bokehScale = uniform(Math.max(0, (state.maxBlur ?? 0.006) * 1_000));
      const dofNode = dof(result, scenePass.getViewZNode(), focusDistance, 50, bokehScale);
      resources.push(dofNode);
      controls.focusDistance = focusDistance;
      controls.bokehScale = bokehScale;
      result = asColorNode(dofNode);
    }

    if (plan.vignette) {
      const intensity = uniform(state.vignetteDarkness ?? 1.2);
      controls.vignette = intensity;
      result = vec4(vignette(result.rgb, intensity, 0.5), result.a);
    }
    if (plan.filmGrain) {
      const intensity = uniform(state.filmGrainIntensity ?? 0.18);
      controls.film = intensity;
      result = asColorNode(film(result, intensity));
    }
    if (plan.afterimage) {
      const damp = uniform(state.afterimageDamp ?? 0.9);
      const afterimageNode = afterImage(result, damp);
      resources.push(afterimageNode);
      controls.afterimage = damp;
      result = asColorNode(afterimageNode);
    }
    if (plan.colorGrading) {
      const hueValue = uniform(((state.hue ?? 0) * Math.PI) / 180);
      const saturationValue = uniform((state.saturation ?? 0) + 1);
      const brightnessValue = uniform(state.brightness ?? 0);
      const contrastValue = uniform((state.contrast ?? 0) + 1);
      controls.hue = hueValue;
      controls.saturation = saturationValue;
      controls.brightness = brightnessValue;
      controls.contrast = contrastValue;
      const adjusted = adjustSaturation(adjustHue(result.rgb, hueValue), saturationValue)
        .add(brightnessValue)
        .sub(0.5)
        .mul(contrastValue)
        .add(0.5)
        .max(0);
      result = vec4(adjusted, result.a);
    }

    if (plan.antialias !== "none") {
      this.#pipeline.outputColorTransform = false;
      if (plan.antialias === "smaa") {
        const smaaNode = smaa(result);
        resources.push(smaaNode);
        result = renderOutput(asColorNode(smaaNode));
      } else {
        const fxaaNode = fxaa(renderOutput(result));
        resources.push(fxaaNode);
        result = asColorNode(fxaaNode);
      }
    } else {
      this.#pipeline.outputColorTransform = true;
    }

    this.#pipeline.outputNode = result;
    this.#pipeline.needsUpdate = true;
    this.#resources = resources;
    this.#controls = controls;
    if (previousResources.length > 0) this.#retiredResources.push(previousResources);
  }

  private updateParameters(state: ScenePostProcessingState, outlinedObjects: THREE.Object3D[]): void {
    if (this.#controls.ao) {
      const intensity = state.gtao ? state.gtaoIntensity ?? 1 : state.ssaoIntensity;
      this.#controls.ao.radius.value = 0.25;
      this.#controls.ao.scale.value = Math.max(0.01, intensity);
      this.#controls.ao.thickness.value = 1;
    }
    if (this.#controls.bloom) {
      this.#controls.bloom.strength.value = state.bloomStrength;
      this.#controls.bloom.threshold.value = state.bloomThreshold;
    }
    if (this.#controls.outline) this.#controls.outline.selectedObjects = outlinedObjects;
    if (this.#controls.outlineStrength) this.#controls.outlineStrength.value = state.outlineStrength ?? 2.5;
    if (this.#controls.vignette) this.#controls.vignette.value = state.vignetteDarkness ?? 1.2;
    if (this.#controls.film) this.#controls.film.value = state.filmGrainIntensity ?? 0.18;
    if (this.#controls.afterimage) this.#controls.afterimage.value = state.afterimageDamp ?? 0.9;
    if (this.#controls.focusDistance) this.#controls.focusDistance.value = state.focusDistance ?? 10;
    if (this.#controls.bokehScale) this.#controls.bokehScale.value = Math.max(0, (state.maxBlur ?? 0.006) * 1_000);
    if (this.#controls.hue) this.#controls.hue.value = ((state.hue ?? 0) * Math.PI) / 180;
    if (this.#controls.saturation) this.#controls.saturation.value = (state.saturation ?? 0) + 1;
    if (this.#controls.brightness) this.#controls.brightness.value = state.brightness ?? 0;
    if (this.#controls.contrast) this.#controls.contrast.value = (state.contrast ?? 0) + 1;
  }
}

function disposeNode(node: DisposableNode): void {
  node.dispose?.();
}

/**
 * Three r185 的 BloomNode 在 TSL 首次编译前没有创建模糊材质，过早 setSize 会访问空数组。
 * 识别这一明确的运行时边界并等待首帧编译，其他节点仍按正常路径及时调整尺寸。
 */
function resizeResource(resource: DisposableNode, width: number, height: number): void {
  const bloomResource = resource as DisposableNode & { _separableBlurMaterials?: unknown[] };
  if (Array.isArray(bloomResource._separableBlurMaterials) && bloomResource._separableBlurMaterials.length === 0) return;
  resource.setSize?.(width, height);
}

/** r184 的部分 addon 声明丢失了实际的 vec4 输出泛型；运行时节点均由官方颜色效果工厂创建。 */
function asColorNode(node: Node): Node<"vec4"> {
  return node as Node<"vec4">;
}
