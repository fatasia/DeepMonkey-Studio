//! B3 RT 反射 closest-hit 帧通道 + P1 RT specular GI·一次反弹 indirection 的
//! 帧编排块(体量门拆分;块体逐字未改,原局部 let 经返回值显式带出,host 字段
//! 懒构造/更新/销毁语义与开关判定位置保持原样——调用方负责 features × directClear 门)。
import type { PbrRendererFrameHost } from "./pbrRendererFrameHost.js";
import type { PbrTransientTextureHandle } from "./pbrTransientTextureTypes.js";
import { defaultScreenSpaceReflectionOptions } from "./pbrPostProcessChain.js";
import { scalePbrEnvironmentRadiance } from "./pbrEnvironmentIntensity.js";
import { invertColumnMajor4x4 } from "./rtShadowFrame.js";
import { RayTraceClosestFramePass } from "../rayTracing/rayTraceClosestFramePass.js";
import { RtSpecularIndirectionPass } from "../rayTracing/rtSpecularFramePasses.js";
import type { updatePbrFrameUniforms } from "./pbrFrameUniforms.js";
import type { resolvePbrPostProcessOverrides } from "./pbrPostProcessOverrides.js";
import type { resolvePbrSceneLighting } from "../lighting/pbrSceneLighting.js";
import type { FrameMetrics, RenderView } from "./pbrRendererTypes.js";

/** RT 反射通道的 depth 采样视图缓存(纹理身份 → 2d 单层;同 megaLights 控制器惯例)。 */
const rtReflectionsDepthViews = new WeakMap<GPUTexture, GPUTextureView>();

function rtReflectionsDepthViewFor(texture: GPUTexture): GPUTextureView {
  let view = rtReflectionsDepthViews.get(texture);
  if (!view) rtReflectionsDepthViews.set(texture, view = texture.createView({ dimension: "2d", mipLevelCount: 1, arrayLayerCount: 1 }));
  return view;
}

/** encodeRtReflectionsFrame 带出的帧内瞬态资源与披露指标(提交后由调用方统一 release)。 */
export interface RtReflectionFrameContribution {
  hit: PbrTransientTextureHandle | undefined;
  bounceShading: PbrTransientTextureHandle | undefined;
  indirectionHandle: PbrTransientTextureHandle | undefined;
  indirectionView: GPUTextureView | undefined;
  metrics: FrameMetrics["rtReflections"] | undefined;
}

/** B3 RT 反射 closest-hit 帧通道(opt-in features.rayTracedReflections,默认关 =
 * 运行时不存在,帧逐位零变化):主帧 1x depth(本帧,depth resolve 之后)重建着色点,
 * 沿镜面反射方向两级 TLAS→BLAS closest-hit,rgba32float [t,normal.xyz] 命中记录
 * 写瞬态纹理;光照遮蔽档补一腿命中点→光源可见性 trace + per-instance 反照率表,
 * rgba32float [albedo.rgb,visibility] 遮蔽记录写第二瞬态纹理。场景复用 RT 阴影
 * staging 通道(未 staging = 不挂载,fail-closed 不静默假开)。反照率表缺省 =
 * 中性 0.5(宿主供给钩子 host.rtReflectionsBounceAlbedos,RenderPacket 材质表接线
 * 属宿主侧下一切片,如实登记)。 */
export function encodeRtReflectionsFrame(host: PbrRendererFrameHost, device: GPUDevice,
  encoder: GPUCommandEncoder, size: { width: number; height: number }, view: RenderView,
  frameState: ReturnType<typeof updatePbrFrameUniforms>,
  postProcess: ReturnType<typeof resolvePbrPostProcessOverrides>,
  sceneLighting: ReturnType<typeof resolvePbrSceneLighting>): RtReflectionFrameContribution {
  let rtReflectionsHit: PbrTransientTextureHandle | undefined;
  let rtBounceShading: PbrTransientTextureHandle | undefined;
  let rtIndirectionHandle: PbrTransientTextureHandle | undefined;
  let rtSpecularIndirectionView: GPUTextureView | undefined;
  let rtReflectionsMetrics: FrameMetrics["rtReflections"] | undefined;
  const packedScene = host.rtShadows?.packedScene;
  if (packedScene !== undefined) {
    try {
      // 光照遮蔽档:反射命中后补命中点→光源可见性 + per-instance 反照率记录。
      host.rtReflections ??= new RayTraceClosestFramePass(host.session.device, packedScene, { illumination: true });
    } catch (error) {
      // fail-closed:f16 缺 feature / WGSL 校验失败 / 超 maxInstances——禁用本帧
      // 通道并如实披露,不静默假开,不抛穿渲染循环(同 rtShadows staging 语义)。
      host.rtReflections = undefined;
      rtReflectionsMetrics = { dispatched: false, reason: `staging: ${(error as Error).message}` };
    }
    if (host.rtReflections !== undefined) {
      if (host.rtReflections.packed !== packedScene) {
        if (host.rtReflections.packed.blasNodeCount === packedScene.blasNodeCount
          && host.rtReflections.packed.triangleCount === packedScene.triangleCount) {
          host.rtReflections.updateTlasRegion(packedScene);
        } else {
          // BLAS 段变化:整体重建 pass(同 shadow 家族 staging 合同;构造失败回
          // 上一档 disabled 披露)。
          host.rtReflections.destroy();
          host.rtReflections = new RayTraceClosestFramePass(host.session.device, packedScene, { illumination: true });
        }
      }
      rtReflectionsHit = host.transientTextures.acquire({ resourceId: "rt-reflection-closest",
        format: "rgba32float", width: size.width, height: size.height, sampleCount: 1,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
      rtBounceShading = host.transientTextures.acquire({ resourceId: "rt-reflection-bounce-shading",
        format: "rgba32float", width: size.width, height: size.height, sampleCount: 1,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
      const invVp = invertColumnMajor4x4(frameState.depthViewProjection);
      const frameEye = view.cameraWorldPosition === undefined ? view.eye
        : [view.eye[0] - view.cameraWorldPosition[0], view.eye[1] - view.cameraWorldPosition[1],
          view.eye[2] - view.cameraWorldPosition[2]] as const;
      // 帧时披露口径:encode 沿 shadow 家族合同异步(await validated),GPU 逐 pass
      // 计时待本通道进入帧执行计划(F1 图节点)后接 passTiming;当前开关帧时差经
      // 既有帧级三段计时(T25)对比,FrameMetrics.rtReflections 披露 dispatch 形状。
      void host.rtReflections.encode(encoder, {
        depthView: rtReflectionsDepthViewFor(host.targets.depthTexture),
        hitView: rtReflectionsHit.view,
        bounceShadingView: rtBounceShading.view,
        lightDirectionWorld: [sceneLighting.primary.surfaceToLightWorld[0]!,
          sceneLighting.primary.surfaceToLightWorld[1]!, sceneLighting.primary.surfaceToLightWorld[2]!],
        ...(host.rtReflectionsBounceAlbedos === undefined ? {} : { instanceAlbedos: host.rtReflectionsBounceAlbedos }),
        width: size.width, height: size.height,
        invViewProjection: [invVp[0]!, invVp[1]!, invVp[2]!, invVp[3]!, invVp[4]!, invVp[5]!,
          invVp[6]!, invVp[7]!, invVp[8]!, invVp[9]!, invVp[10]!, invVp[11]!, invVp[12]!,
          invVp[13]!, invVp[14]!, invVp[15]!],
        eye: frameEye, tMax: view.extent * 8, bias: Math.max(1e-4, view.extent * 1e-3),
        rayMask: 0xffffffff,
      });
      rtReflectionsMetrics = { dispatched: true, width: size.width, height: size.height,
        dispatchX: Math.ceil(size.width / 8), dispatchY: Math.ceil(size.height / 8) };
      // P1 RT specular GI·一次反弹 indirection(opt-in rayTracedReflections × SSR
      // 激活 × 环境可用):命中记录 [t,normal] → 命中点解析一次反弹(主方向光 N·L
      // + F1 ambient 合同环境项,中性反照率;ReSTIR-DI 灯池跨域借表属下一切片)×
      // SSR 同款 split-sum 高光分数 → rgba16float indirection,SSR 合成后屏外填充
      // 消费(pbrPostProcessChain encodeFinal)。任何失败 fail-closed 置回 undefined
      // + 如实披露:填充不发生,SSR 输出逐位透传。
      if (postProcess.screenSpaceReflection && host.environment.current) {
        try {
          host.rtSpecularIndirection ??= new RtSpecularIndirectionPass(device);
          rtIndirectionHandle = host.transientTextures.acquire({ resourceId: "rt-specular-indirection",
            format: "rgba16float", width: size.width, height: size.height, sampleCount: 1,
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
          const ssrDefaults = defaultScreenSpaceReflectionOptions(view.extent);
          host.rtSpecularIndirection.encode(encoder, {
            linearDepthView: host.targets.linearDepth, viewNormalView: host.targets.normal,
            brdfLutView: host.environment.current.brdf, rtHitView: rtReflectionsHit!.view,
            bounceShadingView: rtBounceShading.view,
            indirectionView: rtIndirectionHandle.view, width: size.width, height: size.height,
            params: { width: size.width, height: size.height,
              tanHalfFov: Math.tan(frameState.projection.verticalFovRadians * 0.5),
              aspect: size.width / size.height,
              surfaceToLightWorld: [sceneLighting.primary.surfaceToLightWorld[0]!,
                sceneLighting.primary.surfaceToLightWorld[1]!, sceneLighting.primary.surfaceToLightWorld[2]!],
              lightColor: [sceneLighting.primary.color[0]!, sceneLighting.primary.color[1]!,
                sceneLighting.primary.color[2]!],
              lightIntensity: sceneLighting.primary.intensity,
              envRadiance: scalePbrEnvironmentRadiance(host.environmentAmbient, view.environmentIntensity),
              fresnelF0: ssrDefaults.fresnelF0 } });
          rtSpecularIndirectionView = rtIndirectionHandle.view;
          rtReflectionsMetrics = { ...rtReflectionsMetrics, indirectDispatched: true };
        } catch (error) {
          host.rtSpecularIndirection = undefined;
          rtReflectionsMetrics = { ...rtReflectionsMetrics,
            indirectDispatched: false, indirectReason: (error as Error).message };
        }
      }
    }
  } else {
    rtReflectionsMetrics = { dispatched: false, reason: "scene-not-staged" };
  }
  return { hit: rtReflectionsHit, bounceShading: rtBounceShading, indirectionHandle: rtIndirectionHandle,
    indirectionView: rtSpecularIndirectionView, metrics: rtReflectionsMetrics };
}
