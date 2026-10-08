# Deep Engine Web SDK 模板可用 API 面（@bim-studio/deep-engine 0.2.0）

来源:packages/deep-engine dist `.d.ts` 与已验消费门(scripts/fixtures/deep-engine-consumer、test-output/deep-engine-consumer-20260922)。**只使用此处列出的名称。**

## 模块入口

- `@bim-studio/deep-engine` — `FrameCaptureSession`,类型 `RenderPacket`、`GeometryResource`、`PbrMaterial`、`RenderInstance`、`InstanceUpdate`
- `@bim-studio/deep-engine/app` — `DeepApp`、`PbrRendererPlugin`、`PBR_RENDERER_RESOURCE`、`PBR_RENDERER_FRAME_STATE`、`createDeepAppResource`、`DeepAppInitializationError`
- `@bim-studio/deep-engine/webgpu` — 类型 `RenderView`、`FrameMetrics`、`PbrRendererFeatureOptions`、`PbrToneMapping`

## DeepApp（无 DOM 依赖,Node 可用）

- `DeepApp.create({ state, plugins, mode? })` → `Promise<DeepApp>`;setup 失败抛 `DeepAppInitializationError` 并按逆序回滚已 setup 插件
- `app.advance(timeMs)` — **绝对时间戳**;`deltaMs = timeMs - lastTimeMs`,必须单调递增;返回 `{ status, frameIndex, timeMs, deltaMs }`,`status === "rendered"` 才有画面
- `app.invalidate(reason)` — 无失效调用则 advance 返回 `idle`,不渲染
- `app.dispose()` — 幂等,重复调用返回同一 Promise
- 插件 `DeepAppPlugin`:`{ id, dependencies?, setup(context), }`;context 提供 `provide(resource, value)`、`requireResource(resource)`、`invalidate(reason)`、`addFrameStage({ id, priority?, execute })`、`onDispose(fn)`

## PbrRendererPlugin（浏览器,WebGPU）

```ts
new PbrRendererPlugin<TState>({
  canvas: HTMLCanvasElement,
  gpu: navigator.gpu,
  signal?: AbortSignal,          // 取消初始化/运行
  packet?: RenderPacket,         // 或 (state, app) => RenderPacket
  view: (context) => RenderView, // 每帧相机与氛围
  renderer?: { features?: PbrRendererFeatureOptions,
               frameCapture?: { session: FrameCaptureSession,
                                readbacks: { requests: [{ resourceId: "present-color" }] } } },
})
```

渲染器资源:`app.requireResource(PBR_RENDERER_RESOURCE)` → `renderer.updateInstances({ materials, instances })`(动画)、`renderer.frameReadbackResults`(Promise,readback 结果)、`renderer.session.device`(pushErrorScope/popErrorScope 校验)、`renderer.id`。
帧指标:`app.requireResource(PBR_RENDERER_FRAME_STATE).current` → `FrameMetrics`(`frame`/`drawCalls`/`triangles` 等)。

## RenderPacket

- `geometries: GeometryResource[]` — `{ id, revision, vertices: Float32Array(pos+normal 交错 6float/顶点), indices: Uint32Array(逆时针) }`;可选 `uv0/tangents/colors`
- `materials: PbrMaterial[]` — 必填 `id, baseColor [r,g,b](线性), metallic, roughness`;常用可选 `emissiveFactor, emissiveStrength(0..256), shadingModel: "unlit", alphaMode: "OPAQUE"|"MASK"|"BLEND", baseColorAlpha, alphaCutoff, doubleSided, fog`
- `instances: RenderInstance[]` — 必填 `id, geometry, material, transform`(列主序 mat4,平移在 [12,13,14]);可选 `castShadow, receiveShadow`
  - **注意**:`outline` 标志当前仅在 render-packet 层打包,WebGPU 运行面材质账本会报 surfaceFlags mismatch;选中/高亮请用自发光材质方案
- 同 ID 几何被多实例共享即自动合批;镜像变换(行列式<0)单独批次

## RenderView（每帧必给）

`eye[3], target[3], extent, background[3](线性), floor[3](线性), exposure, roughness, width, height, pixelRatio`。

## 已验特性组合（模板基线 TEMPLATE_FEATURES）

开:`fog, groundGrid, bloom, vignette, toneMapping: "three-aces-r185"`。
关(保守,未经独立消费者门验证):`environment, groundPlane, ambientOcclusion, screenSpaceReflection, volumetricFog, temporalAa, spatialAa, visibilityBuffer, softRasterizeFallback, textureArrays, layeredMaterials, occlusionCulling, contactShadows, temporalUpscale`。开启未验证组合前先跑 `pnpm gate:hc7p2-templates` 取证。
