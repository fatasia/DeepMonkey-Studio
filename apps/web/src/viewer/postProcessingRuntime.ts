import * as THREE from "three";
import { AfterimagePass } from "three/examples/jsm/postprocessing/AfterimagePass.js";
import { BokehPass } from "three/examples/jsm/postprocessing/BokehPass.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { FilmPass } from "three/examples/jsm/postprocessing/FilmPass.js";
import { FXAAPass } from "three/examples/jsm/postprocessing/FXAAPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutlinePass } from "three/examples/jsm/postprocessing/OutlinePass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { VignetteShader } from "three/examples/jsm/shaders/VignetteShader.js";
import { HueSaturationShader } from "three/examples/jsm/shaders/HueSaturationShader.js";
import type { ScenePostProcessingState } from "@bim-studio/contracts";
import type { ViewerPostProcessingRuntime } from "./viewerPostProcessingRuntime";

/**
 * 高成本渲染效果按需加载：普通浏览不创建 Composer，也不为禁用的 pass 分配帧缓冲。
 * 该模块只负责渲染实现，启用策略和场景状态仍由 ViewerEngine 统一持有。
 */
export class PostProcessingRuntime implements ViewerPostProcessingRuntime {
  readonly #composer: EffectComposer;
  readonly #ssaoPass: SSAOPass;
  readonly #gtaoPass: GTAOPass;
  readonly #outlinePass: OutlinePass;
  readonly #bloomPass: UnrealBloomPass;
  readonly #bokehPass: BokehPass;
  readonly #afterimagePass: AfterimagePass;
  readonly #filmPass: FilmPass;
  readonly #vignettePass: ShaderPass;
  readonly #hueSaturationPass: ShaderPass;
  readonly #brightnessContrastPass: ShaderPass;
  readonly #smaaPass: SMAAPass;
  readonly #fxaaPass: FXAAPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.#composer = new EffectComposer(renderer);
    this.#composer.addPass(new RenderPass(scene, camera));
    this.#ssaoPass = this.add(new SSAOPass(scene, camera, 1, 1));
    this.#gtaoPass = this.add(new GTAOPass(scene, camera, 1, 1));
    this.#outlinePass = this.add(new OutlinePass(new THREE.Vector2(1, 1), scene, camera));
    this.#outlinePass.visibleEdgeColor.set(0x4d9fff);
    this.#outlinePass.hiddenEdgeColor.set(0x234a71);
    this.#installSpriteGhostGuard(scene);
    this.#bloomPass = this.add(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.35, 0.25, 0.9));
    this.#bokehPass = this.add(new BokehPass(scene, camera, { focus: 10, aperture: 0.00002, maxblur: 0.006 }));
    this.#afterimagePass = this.add(new AfterimagePass(0.9));
    this.#filmPass = this.add(new FilmPass(0.18, false));
    this.#vignettePass = this.add(new ShaderPass(VignetteShader));
    this.#hueSaturationPass = this.add(new ShaderPass(HueSaturationShader));
    this.#brightnessContrastPass = this.add(new ShaderPass(BRIGHTNESS_CONTRAST_SHADER));
    this.#smaaPass = this.add(new SMAAPass());
    this.#fxaaPass = this.add(new FXAAPass());
    this.#composer.addPass(new OutputPass());
  }

  apply(state: ScenePostProcessingState, outlinedObjects: THREE.Object3D[]): void {
    this.#ssaoPass.enabled = state.enabled && state.ssao;
    this.#ssaoPass.kernelRadius = 8 * state.ssaoIntensity;
    this.#ssaoPass.minDistance = 0.002;
    this.#ssaoPass.maxDistance = 0.12;

    this.#gtaoPass.enabled = state.enabled && Boolean(state.gtao);
    this.#gtaoPass.blendIntensity = state.gtaoIntensity ?? 1;
    this.#bloomPass.enabled = state.enabled && state.bloom;
    this.#bloomPass.strength = state.bloomStrength;
    this.#bloomPass.threshold = state.bloomThreshold;

    this.#outlinePass.selectedObjects = outlinedObjects;
    this.#outlinePass.enabled = outlinedObjects.length > 0;
    this.#outlinePass.edgeStrength = state.outlineStrength ?? 2.5;

    this.#bokehPass.enabled = state.enabled && Boolean(state.depthOfField);
    this.setUniform(this.#bokehPass.uniforms as Record<string, THREE.IUniform>, "focus", state.focusDistance ?? 10);
    this.setUniform(this.#bokehPass.uniforms as Record<string, THREE.IUniform>, "aperture", state.aperture ?? 0.00002);
    this.setUniform(this.#bokehPass.uniforms as Record<string, THREE.IUniform>, "maxblur", state.maxBlur ?? 0.006);

    this.#vignettePass.enabled = state.enabled && Boolean(state.vignette);
    this.setUniform(this.#vignettePass.uniforms as Record<string, THREE.IUniform>, "darkness", state.vignetteDarkness ?? 1.2);
    this.#filmPass.enabled = state.enabled && Boolean(state.filmGrain);
    this.setUniform(this.#filmPass.uniforms as Record<string, THREE.IUniform>, "intensity", state.filmGrainIntensity ?? 0.18);
    this.#afterimagePass.enabled = state.enabled && Boolean(state.afterimage);
    this.#afterimagePass.damp = state.afterimageDamp ?? 0.9;
    this.#hueSaturationPass.enabled = state.enabled && Boolean(state.colorGrading);
    this.setUniform(this.#hueSaturationPass.uniforms, "hue", (state.hue ?? 0) / 180);
    this.setUniform(this.#hueSaturationPass.uniforms, "saturation", state.saturation ?? 0);
    this.#brightnessContrastPass.enabled = state.enabled && Boolean(state.colorGrading);
    this.setUniform(this.#brightnessContrastPass.uniforms, "brightness", state.brightness ?? 0);
    this.setUniform(this.#brightnessContrastPass.uniforms, "contrast", state.contrast ?? 0);
    this.#smaaPass.enabled = state.enabled && state.smaa;
    this.#fxaaPass.enabled = state.enabled && Boolean(state.fxaa);
  }

  suspend(): void {
    this.#outlinePass.selectedObjects = [];
    this.#outlinePass.enabled = false;
  }

  setPixelRatio(value: number): void {
    this.#composer.setPixelRatio(value);
  }

  setSize(width: number, height: number): void {
    this.#composer.setSize(width, height);
  }

  render(delta: number): void {
    this.#composer.render(delta);
  }

  dispose(): void {
    this.#composer.dispose();
  }

  private add<T extends { enabled: boolean }>(pass: T): T {
    pass.enabled = false;
    this.#composer.addPass(pass as never);
    return pass;
  }

  /**
   * S1-A:OutlinePass 的深度/遮罩预通道以 overrideMaterial 渒染整场景,会把 Sprite 的
   * billboard 睾色器替换成世界空间四边形,近景表现为黑色"幽灵板"。只包装 OutlinePass 自身的
   * render(主通道 RenderPass 在 composer 链中独立执行,不受影响),内部渲染期间临时隐藏 Sprite。
   */
  #installSpriteGhostGuard(scene: THREE.Scene): void {
    const outline = this.#outlinePass;
    const originalRender = outline.render.bind(outline);
    const hidden: THREE.Sprite[] = [];
    outline.render = (...args: Parameters<OutlinePass["render"]>) => {
      hidden.length = 0;
      scene.traverse((object) => {
        const sprite = object as THREE.Sprite;
        if (sprite.isSprite && sprite.visible) {
          hidden.push(sprite);
          sprite.visible = false;
        }
      });
      try {
        originalRender(...args);
      } finally {
        for (const sprite of hidden) sprite.visible = true;
      }
    };
  }

  private setUniform(uniforms: Record<string, THREE.IUniform>, key: string, value: number): void {
    const uniform = uniforms[key];
    if (uniform) uniform.value = value;
  }
}

const BRIGHTNESS_CONTRAST_SHADER = {
  uniforms: { tDiffuse: { value: null }, brightness: { value: 0 }, contrast: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float brightness; uniform float contrast; varying vec2 vUv;
    void main(){ vec4 color=texture2D(tDiffuse,vUv); color.rgb+=brightness; color.rgb=(color.rgb-0.5)*(contrast+1.0)+0.5; gl_FragColor=color; }`,
};
