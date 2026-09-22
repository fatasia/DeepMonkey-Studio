import * as THREE from "three";
import type { ScenePostProcessingState } from "@bim-studio/contracts";
import type { PbrEnvironmentSource, PbrRendererOptions, RenderView } from "@bim-studio/deep-engine/webgpu";
import { resolvePbrEnvironmentIntensity } from "@bim-studio/deep-engine/webgpu";
import { projectStudioDeepLights, type StudioDeepEnvironmentIssue } from "./studioDeepEnvironmentLights";

export interface StudioDeepEnvironmentInput {
  readonly scene: THREE.Scene;
  readonly postProcessing: ScenePostProcessingState;
  readonly exposure: number;
  readonly toneMapping: THREE.ToneMapping;
  /** Actual author floor material color, never a derived or hard-coded fallback. */
  readonly floorColor: THREE.Color;
  /** Decoded source for this exact author environment; no substitute studio preset. */
  readonly preparedEnvironment?: PbrEnvironmentSource;
}

export interface StudioDeepEnvironmentProjection {
  readonly renderer: PbrRendererOptions;
  readonly view: Pick<RenderView, "background" | "floor" | "exposure" | "lights" | "colorGrading" | "environmentIntensity">;
  /** Nonempty means the projection must not be published as author-equivalent. */
  readonly issues: readonly StudioDeepEnvironmentIssue[];
}

/** Pure projection: reads author state without changing textures, matrices or post settings. */
export function projectStudioDeepEnvironment(input: StudioDeepEnvironmentInput): StudioDeepEnvironmentProjection {
  const { scene, postProcessing: post } = input;
  const { lights, issues } = projectStudioDeepLights(scene);
  const issue = (code: string, path: string, message: string) => issues.push({ code, path, message });
  if (!(scene.background instanceof THREE.Color)) {
    throw new Error("Deep 环境适配需要作者的纯色背景；纹理、天空盒或透明背景尚未接入。");
  }
  const rgb = (color: THREE.Color): readonly [number, number, number] => {
    const values = [color.r, color.g, color.b] as const;
    if (!values.every(value => Number.isFinite(value) && value >= 0)) throw new Error("作者环境颜色必须为有限非负数。");
    return values;
  };
  if (!Number.isFinite(input.exposure) || input.exposure < 0) throw new Error("作者曝光必须为有限非负数。");
  if (input.toneMapping !== THREE.ACESFilmicToneMapping) issue("tone-mapping", "renderer.toneMapping",
    "Deep 的 Three ACES 路径只对应作者 ACESFilmicToneMapping。");
  const environmentEnabled = Boolean(scene.environment);
  const environmentIntensity = resolvePbrEnvironmentIntensity(scene.environmentIntensity);
  if (environmentEnabled && !input.preparedEnvironment) issue("environment-source", "scene.environment",
    "需要将当前作者环境解码为对应的 Deep HDR 资源，不能用内置 studio 环境替代。");
  if (environmentEnabled && (scene.environmentRotation.x !== 0 || scene.environmentRotation.y !== 0
    || scene.environmentRotation.z !== 0)) issue("environment-rotation", "scene.environmentRotation", "Deep 尚未接入作者环境旋转。");
  if (scene.fog) issue("fog-parameters", "scene.fog", "Deep 固定雾密度和底色尚不能等价表达作者雾类型、颜色及距离。");
  if (post.enabled) {
    const unsupported = ["smaa", "fxaa", "ssao", "gtao", "bloom", "vignette", "outline", "depthOfField",
      "filmGrain", "afterimage"] as const;
    for (const key of unsupported) if (post[key]) issue(`post-${key}`, `postProcessing.${key}`,
      `Deep ${key} 尚未与作者算法及可编辑参数对齐。`);
    if (post.colorGrading && [post.hue, post.saturation, post.brightness, post.contrast].some(value => (value ?? 0) !== 0)) {
      issue("post-color-grading", "postProcessing.colorGrading",
        "作者色相/亮度和显示域对比度不等价于 Deep 线性 HDR 调色，不可直接重用数值。");
    }
  }
  return {
    renderer: { features: { environment: environmentEnabled, fog: Boolean(scene.fog), groundGrid: false,
      ambientOcclusion: post.enabled && Boolean(post.ssao || post.gtao),
      screenSpaceReflection: post.enabled && Boolean(post.screenSpaceReflection), temporalAa: false,
      occlusionCulling: true, bloom: post.enabled && post.bloom, vignette: post.enabled && Boolean(post.vignette),
      toneMapping: "three-aces-r185" },
      ...(environmentEnabled && input.preparedEnvironment ? { environment: input.preparedEnvironment } : {}) },
    view: { background: rgb(scene.background), floor: rgb(input.floorColor), exposure: input.exposure,
      lights, colorGrading: "neutral", environmentIntensity },
    issues,
  };
}
