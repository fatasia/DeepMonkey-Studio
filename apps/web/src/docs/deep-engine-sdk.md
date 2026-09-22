# Deep Engine 独立 SDK

面向在自己的网站、应用或播放器中使用 Deep Engine 的开发者。Web 渲染接口、应用宿主和插件生命周期从独立包导出；Native 嵌入 SDK 仍在建设中。

## 分层与模块

- **场景与资源合同**：数据校验、实例、材质与运行包，入口为 `@bim-studio/deep-engine` 和 `/runtime-package`。
- **资源处理**：glTF/GLB、几何、纹理与调度，入口为 `/gltf`、`/geometry`、`/textures`、`/streaming`。
- **渲染**：WebGPU 设备、提交、光照、阴影与后处理，入口为 `/webgpu`、`/lighting`、`/shadows`、`/postprocess`。
- **宿主**：Canvas、帧循环、输入与业务状态，由接入应用持有。

子路径均以 `@bim-studio/deep-engine` 为前缀。通过包的 exports 导入，不依赖 `src/` 私有路径。Studio 脚本中的 `studio.*` 是另一套宿主 API，不是独立渲染器入口。

## 获取与安装

当前包标记为 private，尚未发布到公共 npm。使用源码构建并生成本地归档，在外部项目安装归档：

```bash
# 在源码仓库根目录
pnpm install --frozen-lockfile
pnpm --filter @bim-studio/deep-engine build
pnpm --filter @bim-studio/deep-engine pack --pack-destination ../../artifacts

# 在自己的项目中，替换为归档的实际路径
npm install /path/to/bim-studio-deep-engine-0.1.0.tgz
```

TypeScript 宿主需要 WebGPU 类型时安装 `@webgpu/types` 并加入 tsconfig 的 types。使用支持 WebGPU 的浏览器，通过 HTTPS 或 localhost 访问。使用与分发遵循仓库 LICENSE；项目采用公开源码许可证。

## Web 接入流程

推荐使用 `DeepApp` 组合模块。宿主持有业务状态和 RAF；引擎负责插件依赖、逐帧调度和释放：

```ts
import { DeepApp, PbrRendererPlugin } from '@bim-studio/deep-engine/app';

const app = await DeepApp.create({
  state: { view },
  mode: 'always',
  plugins: [new PbrRendererPlugin({
    canvas,
    gpu: navigator.gpu,
    packet,
    view: frame => frame.state.view,
  })],
});

let running = true;
async function frame(timeMs: number) {
  if (!running) return;
  await app.advance(timeMs);
  if (app.shouldRequestFrame()) requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

async function stop() {
  running = false;
  await app.dispose();
}
```

应用插件实现 `DeepAppPlugin`。通过 `dependencies` 声明依赖，通过 `provide` 暴露带类型的资源，通过 `addFrameStage` 加入帧阶段，通过 `onDispose` 登记清理。初始化失败会清理已经建立的资源；正常退出按插件和插件内部登记的相反顺序释放。

低层渲染接口也可单独使用：

以下为低层 API 调用顺序；`canvas`、模型字节 `modelBytes`、相机与视口配置 `view` 由宿主提供。

```ts
import { decodeGlb } from '@bim-studio/deep-engine/gltf';
import { PbrRenderer, type RenderView } from '@bim-studio/deep-engine/webgpu';

async function loadFrame(
  canvas: HTMLCanvasElement,
  modelBytes: Uint8Array,
  view: RenderView,
  signal: AbortSignal,
) {
  const packet = decodeGlb(modelBytes, { resourcePrefix: 'model-1' });
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, signal);
  try {
    await renderer.setPacketValidated(packet, signal);
    await renderer.validateFrame(view);
    renderer.render(view);
    return renderer;
  } catch (error) {
    renderer.dispose();
    throw error;
  }
}
```

带纹理的 GLB 使用 `decodeTexturedGlb` 并注入图像解码器。这里的 `decodeGlb` 示例不代表完整纹理加载流程。

## 生命周期与配置

- **创建**：`PbrRenderer.create` 的第四个参数为 `PbrRendererOptions`，可配置环境、阴影、资源预算和特性开关。未传参数使用现有默认值；并非所有高级特性默认开启。
- **加载**：等待 `setPacketValidated` 成功，再显示新场景；捕获取消、资源校验与 GPU 创建错误。
- **更新**：宿主驱动帧循环，调用 `render(view)`。变换变化使用 `updateInstances`，避免重复解码和上传完整几何。
- **视口**：通过 `RenderView` 传入宽高、像素比、相机、背景和曝光等参数。宿主负责尺寸变化与输入映射。
- **退出**：停止宿主帧循环和输入监听，再调用 `dispose()`；加载阶段的取消信号不能替代资源释放。

## 独立接入状态

统一应用入口、按需插件注册、依赖检查、宿主帧驱动、失败清理和逆序释放已经由 `@bim-studio/deep-engine/app` 提供。它复用现有帧循环和生产 WebGPU 渲染器，没有另建渲染内核。默认模块组、输入/GUI 插件、稳定的配置层和 Native 嵌入 API 仍需补齐。

GUI、输入和配置需要共享 Web/Native 合同；尚未完成一致性验收的控件和媒体能力不能视为跨端可用。Native 当前主要提供播放器与 Rust 内部模块，尚无承诺稳定的外部嵌入 ABI。

独立 SDK 已通过仓外消费门禁：从 `dist` 打包，在工作区外使用空缓存离线安装，完成 NodeNext/Bundler 类型解析、插件依赖与逆序释放、真实 Chrome WebGPU 两帧、相机与实例更新、取消和重复释放。浏览器执行只访问本地 fixture；生产 `present-color` GPU 读回验证实际像素，WebGPU validation 与 console/page error 为零。

接入方和引擎维护者可复跑：

```bash
pnpm gate:deep-engine-consumer
```

该门禁证明 Web SDK 可以脱离编辑器服务安装和运行。它不把当前模块列表外推为稳定的 Native 嵌入 ABI，也不代替真实项目资产、长稳和跨设备验收。

参见 [Deep Engine](deep-engine)、[Studio 应用 API](studio-api) 与 [SDK 可运行样例](sdk-examples)。

## 本轮新增能力（2026-09-23 更新）

### DDGI 探针 GI（Web）

`ProbeClipmapPbrController` 提供级联探针 GI：一跳场景辐射捕获（复用 RayBackend 软件 TLAS→BLAS）、环境均值读回、能量钳制、受限历史反馈、Chebyshev 可见性与 DDGI 法线权重泄漏抑制。宿主通过渲染器工厂启用：

```ts
renderer.setProbeClipmapEnabled(true); // radianceSource === 'scene' 表示真实场景捕获
```

禁用或无真实辐射源时自动回退 IBL；不会发布黑色体积。真机证据：`packages/deep-engine/test-output/probe-radiance-gpu-20260922/report.json`。

### GPU 粒子

`GpuParticleRuntime` + `PbrParticlePass` 提供全 GPU 粒子模拟与 billboard 渲染：alarm-pulse / expanding-ring / flow-line 预设、爆发事件、indirect 绘制（CPU 不回读数量）。产品 PBR 帧循环已接线，实际帧间隔驱动（250ms 上限）。真机证据：`packages/deep-engine/test-output/gpu-particle-render-20260923/report.json`。

### Cluster LOD 间接执行

`ClusterLodIndirectExecutor` 把既有 cluster selection/indirect plan 接入 WebGPU：GPU command upload、resident geometry 校验、render bundle 缓存、`drawIndexedIndirect`。真机像素对拍证据：`packages/deep-engine/test-output/cluster-lod-gpu-20260920-r1/evidence.json`（real GPU draw PASSED）。

### 静态光照描述符

运行包环境合同新增 `RuntimeStaticLightmapDescriptor`（`deep-engine.static-lightmap` v1）：纹理 id、SHA-256、UV set、色彩空间、强度与尺寸在构建期 fail-closed 校验（纹理存在性、occlusion/emissive 语义、尺寸匹配、hash 一致、UV set 存在于几何）。

### 着色器作者图合同

`@bim-studio/deep-engine` 现公开 WGSL-first 作者图合同：`ShaderGraphAssetV1`、节点 registry、canonical 序列化与 hash、fail-closed 校验、到既有 WGSL 编译器 IR 的确定性 lowering、编辑器诊断 MessageStore、预览准备合同与 SubGraph 依赖清单。可视化编辑器仍在开发；当前合同已被 lowering 测试与 shader 套件覆盖。

### 探针网格 GI（Native 消费链，2026-09-23）

单层探针网格从 Web 打包到 Native 像素消费全链可用：

- **打包**：`packNativeProbeGridRecords(level, probes)`（`deep-engine/lighting`）把 origin/spacing/gridSize + 探针数组编码为 Native binding 11 的"网格头 + 96B 记录"扁平数组；网格 2–64、预算 65,535、字段越界一律 fail-closed。字节布局与 Rust `probe_gi_grid` 头解码合同逐字对拍（10 项测试）。
- **发布**：`compileSceneRuntimePackage` 可选 `irradianceProbes` 输入——origin 经局部化到包坐标系后随环境载荷发布，evidence 标记 `deep.scene.probe-grid.v1`；缺省不写字段，旧包逐位不变。
- **消费**：Native `frame.lightDirection.w` 开关通道三态——0 关（逐位不变）/ 1 最近探针 / ≥1.5 网格三线性 8-tap（三线性 × validity × Chebyshev × 法线权重 bias=3；半球判断用原始着色点，0.2 格偏移只进可见性测试）。头/记录数/世界位置任一非法返回零。真机像素证据：`packages/deep-engine-native/test-output/f2-rt-raster-parity-*` 同族装配下的开关帧对拍测试（`probe_grid_trilinear_adds_uniform_ambient_on_real_gpu`）。
- **边界**：多层 clipmap 级联与 GPU 烘焙编排（捕获→读回→聚合）尚未接线。

### 物理碰撞体调试视图（B3）

`ViewerEngineSimulation.collectPhysicsDebugColliders()` 返回全部已登记 Cuboid 碰撞体的世界位姿/半尺寸/局部偏移（`translationWrtParent` 语义经真机 WASM 测试钉死）；渲染层 `createPhysicsDebugOverlay()` 按刚体类型四色线框（depthTest 关闭、renderOrder 10_000），`setPhysicsDebugVisible(false)` 帧同步早退零开销。物理面板提供"显示碰撞体"开关。未验证边界：真实画面中的视觉表现（headless 无法挂载 renderer）。

### 场景动画播放区间（发布语义）

编辑器时间轴的入点/出点（`SceneAnimationState.playbackRange`）随发布包下译为 `dynamic-animation.playbackRangeMs`（合同校验 0 ≤ in < out ≤ duration 非退化，serde default 兼容旧包）；Native `sample_animation` 与发布查看器采样均钳制进区间。缺省（未设区间）播放整条时间线。
